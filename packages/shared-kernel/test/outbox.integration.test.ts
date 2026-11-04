import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createDomainEvent, type DomainEvent, parseCompanyId, runWithCompany } from '../src/index.ts';
import {
  appendToOutbox,
  CrossTenantEventError,
  migrateSharedKernel,
  OutboxRelay,
  TenantDatabase,
} from '../src/postgres/index.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';

const companyA = parseCompanyId('a1b2c3d4-0000-4000-8000-00000000000a');
const companyB = parseCompanyId('a1b2c3d4-0000-4000-8000-00000000000b');

const eventFor = (companyId: typeof companyA, name = 'api') =>
  createDomainEvent({ eventType: 'ApplicationCreated', companyId, payload: { name } });

describe('tenant isolation and the outbox', () => {
  let database: TestDatabase;
  let appPool: pg.Pool;
  let relayPool: pg.Pool;
  let tenantDatabase: TenantDatabase;

  const save = (event: DomainEvent, companyId = event.companyId) =>
    runWithCompany(companyId, () => tenantDatabase.transaction((tx) => appendToOutbox(tx, [event])));

  const visibleEventIds = (companyId: typeof companyA) =>
    runWithCompany(companyId, () =>
      tenantDatabase.transaction(async (tx) => {
        const { rows } = await tx.query('SELECT event_id FROM kernel.outbox');
        return rows.map((row) => row.event_id as string);
      }),
    );

  beforeAll(async () => {
    database = await startTestDatabase();
    // One connection forces the tests to reuse it, which would expose a leaked tenant setting.
    appPool = new pg.Pool({ connectionString: database.urlFor('app'), max: 1 });
    relayPool = new pg.Pool({ connectionString: database.urlFor('relay'), max: 2 });
    tenantDatabase = new TenantDatabase(appPool);
  });

  afterEach(async () => {
    // Clears anything a test left unpublished, so it can't affect the next test.
    const relay = new OutboxRelay(relayPool, { publish: async () => {} }, { batchSize: 1000 });
    await relay.publishBatch();
  });

  afterAll(async () => {
    await appPool.end();
    await relayPool.end();
    await database.stop();
  });

  describe('row-level security', () => {
    it('shows a company only its own events', async () => {
      const eventA = eventFor(companyA);
      const eventB = eventFor(companyB);
      await save(eventA);
      await save(eventB);

      const seenByA = await visibleEventIds(companyA);
      const seenByB = await visibleEventIds(companyB);

      expect(seenByA).toContain(eventA.eventId);
      expect(seenByA).not.toContain(eventB.eventId);
      expect(seenByB).toContain(eventB.eventId);
      expect(seenByB).not.toContain(eventA.eventId);
    });

    it('shows nothing when no company is set', async () => {
      await save(eventFor(companyA));

      const { rows } = await appPool.query('SELECT * FROM kernel.outbox');

      expect(rows).toEqual([]);
    });

    it('does not leak the company to the next user of a connection', async () => {
      await save(eventFor(companyA));
      await visibleEventIds(companyA);

      const { rows } = await appPool.query("SELECT current_setting('app.current_company_id', true) AS company");

      expect(rows[0].company ?? '').toBe('');
    });

    it("rejects writing another company's data, even with raw SQL", async () => {
      const foreign = eventFor(companyB);

      await expect(
        runWithCompany(companyA, () =>
          tenantDatabase.transaction((tx) =>
            tx.query(
              `INSERT INTO kernel.outbox (event_id, event_type, event_version, company_id, occurred_at, payload)
               VALUES ($1, $2, 1, $3, now(), '{}')`,
              [foreign.eventId, foreign.eventType, foreign.companyId],
            ),
          ),
        ),
      ).rejects.toThrow('row-level security');
    });

    it('rejects the application changing or deleting events', async () => {
      await save(eventFor(companyA));

      await expect(
        runWithCompany(companyA, () =>
          tenantDatabase.transaction((tx) => tx.query('UPDATE kernel.outbox SET published_at = now()')),
        ),
      ).rejects.toThrow('permission denied');
      await expect(
        runWithCompany(companyA, () => tenantDatabase.transaction((tx) => tx.query('DELETE FROM kernel.outbox'))),
      ).rejects.toThrow('permission denied');
    });

    it('applies to the table owner too', async () => {
      await save(eventFor(companyA));
      const owner = new pg.Client({ connectionString: database.urlFor('owner') });
      await owner.connect();
      try {
        const { rows } = await owner.query('SELECT * FROM kernel.outbox');
        expect(rows).toEqual([]);
      } finally {
        await owner.end();
      }
    });

    it('limits the relay to marking events as published', async () => {
      await save(eventFor(companyA));

      await expect(relayPool.query("UPDATE kernel.outbox SET payload = '{}'")).rejects.toThrow('permission denied');
      await expect(relayPool.query('DELETE FROM kernel.outbox')).rejects.toThrow('permission denied');
    });
  });

  describe('saving events', () => {
    it('keeps the event when the transaction commits', async () => {
      const event = eventFor(companyA);

      await save(event);

      await expect(visibleEventIds(companyA)).resolves.toContain(event.eventId);
    });

    it('discards the event when the business change fails', async () => {
      const event = eventFor(companyA);

      await expect(
        runWithCompany(companyA, () =>
          tenantDatabase.transaction(async (tx) => {
            await appendToOutbox(tx, [event]);
            throw new Error('Business rule failed');
          }),
        ),
      ).rejects.toThrow('Business rule failed');

      await expect(visibleEventIds(companyA)).resolves.not.toContain(event.eventId);
    });

    it('rejects an event from another company before reaching the database', async () => {
      await expect(save(eventFor(companyB), companyA)).rejects.toThrow(CrossTenantEventError);
    });

    it('requires a company context', async () => {
      await expect(tenantDatabase.transaction(async () => {})).rejects.toThrow('runWithCompany');
    });
  });

  describe('relay', () => {
    it('publishes events from every company in the order they were saved', async () => {
      const first = eventFor(companyA, 'first');
      const second = eventFor(companyB, 'second');
      const third = eventFor(companyA, 'third');
      await save(first);
      await save(second);
      await save(third);
      const published: DomainEvent[] = [];
      const relay = new OutboxRelay(relayPool, { publish: async (event) => void published.push(event) });

      await expect(relay.publishBatch()).resolves.toBe(3);

      expect(published.map((event) => event.eventId)).toEqual([first.eventId, second.eventId, third.eventId]);
      expect(published[0]).toEqual(first);
    });

    it('does not publish an event twice', async () => {
      await save(eventFor(companyA));
      const publish = vi.fn(async () => {});
      const relay = new OutboxRelay(relayPool, { publish });

      await relay.publishBatch();
      await expect(relay.publishBatch()).resolves.toBe(0);

      expect(publish).toHaveBeenCalledTimes(1);
    });

    it('keeps events for retry when publishing fails', async () => {
      const event = eventFor(companyA);
      await save(event);
      const failing = new OutboxRelay(relayPool, {
        publish: async () => {
          throw new Error('Queue is down');
        },
      });

      await expect(failing.publishBatch()).rejects.toThrow('Queue is down');

      const published: DomainEvent[] = [];
      const recovered = new OutboxRelay(relayPool, { publish: async (e) => void published.push(e) });
      await recovered.publishBatch();
      expect(published.map((e) => e.eventId)).toEqual([event.eventId]);
    });

    it('lets two relays run without taking the same events', async () => {
      for (let index = 0; index < 20; index += 1) {
        await save(eventFor(companyA, String(index)));
      }
      const published: string[] = [];
      const publisher = {
        publish: async (event: DomainEvent) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          published.push(event.eventId);
        },
      };
      const relayOne = new OutboxRelay(relayPool, publisher, { batchSize: 10 });
      const relayTwo = new OutboxRelay(relayPool, publisher, { batchSize: 10 });

      await Promise.all([relayOne.publishBatch(), relayTwo.publishBatch()]);
      await relayOne.publishBatch();

      expect(published).toHaveLength(20);
      expect(new Set(published).size).toBe(20);
    });

    it('publishes on its own once started, and stops cleanly', async () => {
      const event = eventFor(companyA);
      const published: string[] = [];
      const relay = new OutboxRelay(
        relayPool,
        { publish: async (e) => void published.push(e.eventId) },
        { pollIntervalMs: 20 },
      );
      relay.start();

      await save(event);
      await vi.waitFor(() => expect(published).toContain(event.eventId), { timeout: 5_000 });
      await relay.stop();

      const after = eventFor(companyA);
      await save(after);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(published).not.toContain(after.eventId);
    });
  });

  describe('migrations', () => {
    it('do nothing when run again', async () => {
      await expect(migrateSharedKernel(database.urlFor('owner'))).resolves.toEqual([]);
    });
  });
});
