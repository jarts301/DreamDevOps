import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { parseCompanyId, runWithCompany } from '../src/index.ts';
import { TenantDatabase } from '../src/postgres/index.ts';

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
