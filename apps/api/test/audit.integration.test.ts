import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDomainEvent, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { AuditLog } from '../src/audit/application/audit-log.ts';
import { postgresAuditStore } from '../src/audit/infrastructure/postgres-audit-store.ts';
import { PostgresCompanyDirectory } from '../src/tenancy/infrastructure/postgres-company-directory.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';

let database: TestDatabase;
let app: pg.Pool;
let superuser: pg.Pool;
let audit: AuditLog;

beforeAll(async () => {
  database = await startTestDatabase();
  app = new pg.Pool({ connectionString: database.urlFor('app') });
  superuser = new pg.Pool({ connectionString: database.superuserUrl() });
  audit = new AuditLog(postgresAuditStore(new TenantDatabase(app), app), new PostgresCompanyDirectory(app));
}, 120_000);

afterAll(async () => {
  await app?.end();
  await superuser?.end();
  await database?.stop();
});

/** A company, made the way Tenancy's table holds it. */
const company = async (name: string) => {
  const id = parseCompanyId(randomUUID());
  await superuser.query("INSERT INTO tenancy.companies (id, name, slug, status) VALUES ($1, $2, $3, 'active')", [
    id,
    name,
    `company-${id.slice(0, 8)}`,
  ]);
  return id;
};

/** Records events in a company's history, as the audit log's subscriber does. */
const record = (companyId: ReturnType<typeof parseCompanyId>, count: number, options: { actorId?: string; occurredAt?: Date } = {}) =>
  runWithCompany(companyId, async () => {
    for (let index = 0; index < count; index += 1) {
      await audit.record(
        createDomainEvent({
          eventType: 'ApplicationRegistered',
          companyId,
          actorId: options.actorId ?? null,
          payload: { index },
          ...(options.occurredAt !== undefined && { occurredAt: options.occurredAt }),
        }),
      );
    }
  });

describe("a person's own actions", () => {
  it('page without skipping or repeating entries that share a time, with each company by name', async () => {
    const actorId = randomUUID();
    const first = await company('Acme Audit');
    const second = await company('Globex Audit');
    // Sixty entries at the same moment: more than a page, all tied on time.
    const moment = new Date('2026-06-01T12:00:00.000Z');
    await record(first, 40, { actorId, occurredAt: moment });
    await record(second, 20, { actorId, occurredAt: moment });

    const page = await audit.listByActor(actorId, undefined);
    expect(page.entries).toHaveLength(50);
    expect(page.nextBefore).not.toBeNull();
    const rest = await audit.listByActor(actorId, page.nextBefore);

    expect(rest.entries).toHaveLength(10);
    expect(rest.nextBefore).toBeNull();
    const seen = [...page.entries, ...rest.entries].map((entry) => `${entry.companyId}:${(entry.payload as { index: number }).index}`);
    expect(new Set(seen).size).toBe(60);
    expect(new Set([...page.entries, ...rest.entries].map((entry) => entry.companyName))).toEqual(new Set(['Acme Audit', 'Globex Audit']));
  });

  it('still take a cursor of only a time, as pages made before returned', async () => {
    const actorId = randomUUID();
    const acme = await company('Initech Audit');
    await record(acme, 3, { actorId, occurredAt: new Date('2026-06-01T10:00:00.000Z') });

    const older = await audit.listByActor(actorId, '2026-06-01T11:00:00.000Z');
    const none = await audit.listByActor(actorId, '2026-06-01T09:00:00.000Z');

    expect([older.entries.length, none.entries.length]).toEqual([3, 0]);
  });
});

describe("checking a company's history", () => {
  it('checks a history longer than one batch, and finds the entry that was changed', async () => {
    const companyId = await company('Umbrella Audit');
    await record(companyId, 1_005);

    expect(await runWithCompany(companyId, () => audit.verify())).toEqual({ valid: true, checked: 1_005, brokenAtSequence: null, reason: null });

    // Only someone who gets around the database's own refusal can change history.
    const client = await superuser.connect();
    try {
      await client.query("SET session_replication_role = 'replica'");
      await client.query(`UPDATE audit.entries SET payload = '{"index": -1}' WHERE company_id = $1 AND sequence = 1003`, [companyId]);
    } finally {
      await client.query("SET session_replication_role = 'origin'");
      client.release();
    }

    expect(await runWithCompany(companyId, () => audit.verify())).toEqual({
      valid: false,
      checked: 1_002,
      brokenAtSequence: 1_003,
      reason: 'This entry was changed after it was recorded.',
    });
  });
});

describe("a company's history", () => {
  it('records an event delivered twice only once, and lists it newest first, in its words, with who did it', async () => {
    const companyId = await company('Hooli Audit');
    const event = createDomainEvent({
      eventType: 'ApplicationRegistered',
      companyId,
      payload: { applicationId: randomUUID(), name: 'Billing', slug: 'billing', type: 'web' },
      occurredAt: new Date('2026-06-01T12:00:00.000Z'),
    });
    await record(companyId, 2, { occurredAt: new Date('2026-06-01T10:00:00.000Z') });

    await runWithCompany(companyId, () => audit.record(event));
    await runWithCompany(companyId, () => audit.record(event));
    const page = await runWithCompany(companyId, () => audit.listCompany(undefined));

    expect(page.entries.map((entry) => entry.sequence)).toEqual([3, 2, 1]);
    expect(page.entries[0]).toMatchObject({
      eventType: 'ApplicationRegistered',
      description: 'Registered the application "Billing"',
      actor: null,
      occurredAt: '2026-06-01T12:00:00.000Z',
    });
    expect(page.nextBefore).toBeNull();
    expect(await runWithCompany(companyId, () => audit.verify())).toMatchObject({ valid: true, checked: 3 });
  });
});
