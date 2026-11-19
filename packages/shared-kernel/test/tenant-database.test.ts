import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createDomainEvent, parseCompanyId, runWithCompany } from '../src/index.ts';
import { CrossTenantEventError, PostgresSession, TenantDatabase, transactional } from '../src/postgres/index.ts';

const companyId = parseCompanyId('a1b2c3d4-0000-4000-8000-00000000000a');

/** A pool with one connection, whose ROLLBACK can be made to fail, as on a dropped connection. */
const poolWith = (options: { rollbackFails: boolean }) => {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql === 'ROLLBACK' && options.rollbackFails) {
        throw new Error('Connection terminated');
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool, client };
};

describe('TenantDatabase', () => {
  it('gives the connection back to the pool after a rollback', async () => {
    const { pool, client } = poolWith({ rollbackFails: false });

    await expect(
      runWithCompany(companyId, () =>
        new TenantDatabase(pool).transaction(async () => {
          throw new Error('Business rule');
        }),
      ),
    ).rejects.toThrow('Business rule');

    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('closes a connection whose rollback failed, rather than reuse it, and reports the first error', async () => {
    const { pool, client } = poolWith({ rollbackFails: true });

    await expect(
      runWithCompany(companyId, () =>
        new TenantDatabase(pool).transaction(async () => {
          throw new Error('Business rule');
        }),
      ),
    ).rejects.toThrow('Business rule');

    expect(client.release).toHaveBeenCalledWith(expect.objectContaining({ message: 'Connection terminated' }));
  });
});

describe('TenantDatabase roles and queries across companies', () => {
  it('runs a query across companies in its own transaction, as the role, with no company set', async () => {
    const { pool, client } = poolWith({ rollbackFails: false });

    await new TenantDatabase(pool).acrossCompanies({ role: 'dreamdevops_names' }).query('SELECT name FROM names.all WHERE id = $1', ['x']);

    expect(client.query.mock.calls).toEqual([
      ['BEGIN'],
      ['SET LOCAL ROLE dreamdevops_names'],
      ['SELECT name FROM names.all WHERE id = $1', ['x']],
      ['COMMIT'],
    ]);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('needs no company context for a query across companies', async () => {
    const { pool } = poolWith({ rollbackFails: false });

    await expect(new TenantDatabase(pool).acrossCompanies({ role: 'dreamdevops_names' }).query('SELECT 1')).resolves.toEqual({ rows: [] });
  });

  it('refuses a role name that could carry SQL, before using a connection', async () => {
    const { pool, client } = poolWith({ rollbackFails: false });

    await expect(
      runWithCompany(companyId, () => new TenantDatabase(pool).transaction(async () => 'done', { role: 'app; DROP TABLE names' })),
    ).rejects.toThrow('is not a database role name');
    await expect(new TenantDatabase(pool).acrossCompanies({ role: 'Names' }).query('SELECT 1')).rejects.toThrow('is not a database role name');
    expect(client.query).not.toHaveBeenCalled();
  });

  it('rejects, rather than throws, outside a company context', () => {
    const { pool } = poolWith({ rollbackFails: false });

    const result = new TenantDatabase(pool).transaction(async () => 'done', { role: 'dreamdevops_names' });

    return expect(result).rejects.toThrow('runWithCompany');
  });

  it('runs as the login role when no role is given', async () => {
    const { pool, client } = poolWith({ rollbackFails: false });

    await runWithCompany(companyId, () => new TenantDatabase(pool).transaction(async () => 'done'));

    expect(client.query.mock.calls.map(([sql]) => sql)).not.toContain(expect.stringContaining('SET LOCAL ROLE'));
  });
});

describe('transactional', () => {
  class NamesSession extends PostgresSession {
    async rename(name: string): Promise<void> {
      await this.tx.query('UPDATE names SET name = $1', [name]);
    }
  }

  it('runs the work and records its events in one transaction, which commits once it all succeeds', async () => {
    const { pool, client } = poolWith({ rollbackFails: false });
    const store = transactional(new TenantDatabase(pool), (tx) => new NamesSession(tx), { role: 'dreamdevops_names' });
    const event = createDomainEvent({ eventType: 'Renamed', companyId, payload: { name: 'New' } });

    const result = await runWithCompany(companyId, () =>
      store.transaction(async (session) => {
        await session.rename('New');
        await session.record([event]);
        return 'done';
      }),
    );

    const statements = client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/).slice(0, 3).join(' '));
    expect(result).toBe('done');
    expect(statements).toEqual([
      'BEGIN',
      'SET LOCAL ROLE',
      "SELECT set_config('app.current_company_id', $1,",
      'UPDATE names SET',
      'INSERT INTO kernel.outbox',
      'COMMIT',
    ]);
    expect(client.query.mock.calls[1]![0]).toBe('SET LOCAL ROLE dreamdevops_names');
  });

  it("refuses to record another company's event, and rolls back the change with it", async () => {
    const { pool, client } = poolWith({ rollbackFails: false });
    const store = transactional(new TenantDatabase(pool), (tx) => new NamesSession(tx), { role: 'dreamdevops_names' });
    const otherCompany = parseCompanyId('a1b2c3d4-0000-4000-8000-00000000000b');
    const event = createDomainEvent({ eventType: 'Renamed', companyId: otherCompany, payload: { name: 'New' } });

    await expect(
      runWithCompany(companyId, () =>
        store.transaction(async (session) => {
          await session.rename('New');
          await session.record([event]);
        }),
      ),
    ).rejects.toThrow(CrossTenantEventError);

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes('kernel.outbox'))).toBe(false);
    expect(statements).toContain('ROLLBACK');
  });

  it('rolls back the change and its events together when the work fails', async () => {
    const { pool, client } = poolWith({ rollbackFails: false });
    const store = transactional(new TenantDatabase(pool), (tx) => new NamesSession(tx), { role: 'dreamdevops_names' });

    await expect(
      runWithCompany(companyId, () =>
        store.transaction(async (session) => {
          await session.rename('New');
          throw new Error('Business rule');
        }),
      ),
    ).rejects.toThrow('Business rule');

    expect(client.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(client.query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
  });
});
