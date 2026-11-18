import type { Pool } from 'pg';
import { parseCompanyId } from '../domain/company-id.ts';
import type { DomainEvent } from '../domain/domain-event.ts';
import type { EventPublisher } from '../application/ports.ts';
import { rollBack } from './tenant-database.ts';

interface OutboxRow {
  sequence: string;
  event_id: string;
  event_type: string;
  event_version: number;
  company_id: string;
  actor_id: string | null;
  occurred_at: Date;
  payload: object;
}

/** How many delivered events one purge statement removes, so none holds locks for long. */
const PURGE_BATCH = 5_000;

export interface OutboxRelayOptions {
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * Moves saved events from the outbox to the publisher. Use a pool that logs in as
 * the dreamdevops_relay role, the only role allowed to read across companies.
 *
 * A crash between publishing and marking an event sends it again, so delivery is
 * at least once. Row locks let several relays run without taking the same events.
 */
export class OutboxRelay {
  readonly #pool: Pool;
  readonly #publisher: EventPublisher;
  readonly #batchSize: number;
  readonly #pollIntervalMs: number;
  readonly #onError: (error: unknown) => void;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #started = false;

  constructor(pool: Pool, publisher: EventPublisher, options: OutboxRelayOptions = {}) {
    this.#pool = pool;
    this.#publisher = publisher;
    this.#batchSize = options.batchSize ?? 100;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#onError = options.onError ?? ((error) => console.error('Outbox relay failed.', error));
  }

  /** Publishes one batch and returns how many events it published. */
  async publishBatch(): Promise<number> {
    const client = await this.#pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<OutboxRow>(
        `SELECT sequence, event_id, event_type, event_version, company_id, actor_id, occurred_at, payload
         FROM kernel.outbox
         WHERE published_at IS NULL
         ORDER BY sequence
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [this.#batchSize],
      );
      for (const row of rows) {
        await this.#publisher.publish(toDomainEvent(row));
      }
      if (rows.length > 0) {
        await client.query('UPDATE kernel.outbox SET published_at = now() WHERE sequence = ANY($1::bigint[])', [
          rows.map((row) => row.sequence),
        ]);
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (error) {
      broken = await rollBack(client);
      throw error;
    } finally {
      client.release(broken);
    }
  }

  /**
   * Removes events delivered before a time, a batch at a time, and returns how many. They're
   * no longer needed: the audit log keeps every event, and duplicates are refused by job ID.
   */
  async purgePublished(publishedBefore: Date): Promise<number> {
    let removed = 0;
    for (;;) {
      const { rows } = await this.#pool.query<{ removed: number }>('SELECT kernel.purge_published_outbox($1, $2) AS removed', [
        publishedBefore,
        PURGE_BATCH,
      ]);
      const batch = rows[0]?.removed ?? 0;
      removed += batch;
      if (batch < PURGE_BATCH) {
        return removed;
      }
    }
  }

  start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#schedule(0);
  }

  /** Stops polling and waits for any batch in progress. */
  async stop(): Promise<void> {
    this.#started = false;
    clearTimeout(this.#timer);
    await this.#running;
  }

  #schedule(delayMs: number): void {
    this.#timer = setTimeout(() => {
      this.#running = this.#tick();
    }, delayMs);
  }

  async #tick(): Promise<void> {
    let published = 0;
    try {
      published = await this.publishBatch();
    } catch (error) {
      this.#onError(error);
    }
    if (this.#started) {
      // A full batch suggests more is waiting, so it continues without pausing.
      this.#schedule(published === this.#batchSize ? 0 : this.#pollIntervalMs);
    }
  }
}

function toDomainEvent(row: OutboxRow): DomainEvent {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    companyId: parseCompanyId(row.company_id),
    actorId: row.actor_id,
    occurredAt: row.occurred_at.toISOString(),
    payload: row.payload,
  };
}
