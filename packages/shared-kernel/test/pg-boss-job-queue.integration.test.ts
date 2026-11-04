import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import {
  createDomainEvent,
  currentCompanyId,
  deadLetterQueueName,
  EventBus,
  parseCompanyId,
  runWithCompany,
} from '../src/index.ts';
import { appendToOutbox, OutboxRelay, PgBossJobQueue, TenantDatabase } from '../src/postgres/index.ts';
import { describeJobQueueContract } from './job-queue-contract.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';

describeJobQueueContract('pg-boss', async () => {
  const database = await startTestDatabase();
  const queue = await PgBossJobQueue.start({
    connectionString: database.urlFor('jobs'),
    pollingIntervalSeconds: 0.5,
  });
  const inspector = new pg.Pool({ connectionString: database.urlFor('jobs'), max: 1 });

  return {
    queue,
    eventually: (assertion) => vi.waitFor(assertion, { timeout: 15_000, interval: 100 }),
    deadLetters: async (queueName) => {
      const { rows } = await inspector.query('SELECT id, data FROM pgboss.job WHERE name = $1', [
        deadLetterQueueName(queueName),
      ]);
      return rows as { id: string; data: object }[];
    },
    stop: async () => {
      await queue.stop();
      await inspector.end();
      await database.stop();
    },
  };
});

describe('from a saved event to a running handler', () => {
  const companyId = parseCompanyId('a1b2c3d4-0000-4000-8000-00000000000a');
  let database: TestDatabase;
  let appPool: pg.Pool;
  let relayPool: pg.Pool;
  let queue: PgBossJobQueue;

  beforeAll(async () => {
    database = await startTestDatabase();
    appPool = new pg.Pool({ connectionString: database.urlFor('app') });
    relayPool = new pg.Pool({ connectionString: database.urlFor('relay') });
    queue = await PgBossJobQueue.start({ connectionString: database.urlFor('jobs'), pollingIntervalSeconds: 0.5 });
  });

  afterAll(async () => {
    await queue.stop();
    await appPool.end();
    await relayPool.end();
    await database.stop();
  });

  it('delivers the event once, in the right company, with access to its data', async () => {
    const bus = new EventBus(queue);
    const relay = new OutboxRelay(relayPool, bus);
    const tenantDatabase = new TenantDatabase(appPool);
    const seen: { company: string; visibleEvents: number }[] = [];
    const event = createDomainEvent({ eventType: 'ApplicationCreated', companyId, payload: { name: 'api' } });

    await bus.subscribe('ApplicationCreated', 'audit', async () => {
      const visibleEvents = await tenantDatabase.transaction(async (tx) => {
        const { rows } = await tx.query('SELECT count(*)::int AS total FROM kernel.outbox');
        return rows[0].total as number;
      });
      seen.push({ company: currentCompanyId(), visibleEvents });
    });

    await runWithCompany(companyId, () => tenantDatabase.transaction((tx) => appendToOutbox(tx, [event])));
    await relay.publishBatch();
    // Publishing the same event again simulates a crash before it was marked as published.
    await bus.publish(event);

    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 15_000, interval: 100 });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(seen).toEqual([{ company: companyId, visibleEvents: 1 }]);
  });

  it('keeps job tables out of reach of the application role', async () => {
    await expect(appPool.query('SELECT * FROM pgboss.job')).rejects.toThrow('permission denied');
  });
});
