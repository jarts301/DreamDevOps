import { currentCompanyId, type DomainEvent } from '@dreamdevops/shared-kernel';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type { Pool } from 'pg';
import { type ChainCheck, entryHash, GENESIS_HASH, type StoredEntry, verifyChain } from '../domain/hash-chain.ts';

const PAGE_SIZE = 50;
const VERIFY_BATCH = 1_000;

export interface AuditEntryView {
  readonly sequence: number;
  readonly eventType: string;
  readonly actor: { readonly userId: string; readonly displayName: string | null } | null;
  readonly occurredAt: string;
  readonly payload: object;
}

export interface ActorEntryView {
  readonly companyId: string;
  readonly companyName: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payload: object;
}

interface EntryRow {
  company_id: string;
  sequence: string;
  event_id: string;
  event_type: string;
  event_version: number;
  actor_id: string | null;
  occurred_at: Date;
  payload: object;
  previous_hash: string;
  hash: string;
}

/** Every company's history of changes. Entries are only ever added. */
export class AuditLog {
  readonly #database: TenantDatabase;
  readonly #pool: Pool;

  constructor(database: TenantDatabase, pool: Pool) {
    this.#database = database;
    this.#pool = pool;
  }

  /** Records an event in its company's history. Runs in the event's company context. */
  async record(event: DomainEvent): Promise<void> {
    await this.#database.transaction(async (tx) => {
      // One writer per company at a time, so the chain can't fork.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('audit:' || $1, 0))", [currentCompanyId()]);
      const { rows: existing } = await tx.query('SELECT 1 FROM audit.entries WHERE event_id = $1', [event.eventId]);
      if (existing.length > 0) {
        return;
      }
      const { rows: last } = await tx.query<{ sequence: string; hash: string }>(
        'SELECT sequence, hash FROM audit.entries ORDER BY sequence DESC LIMIT 1',
      );
      const previousHash = last[0]?.hash ?? GENESIS_HASH;
      const entry = {
        companyId: currentCompanyId(),
        sequence: Number(last[0]?.sequence ?? 0) + 1,
        eventId: event.eventId,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        actorId: event.actorId,
        occurredAt: new Date(event.occurredAt).toISOString(),
        payload: event.payload,
      };
      await tx.query(
        `INSERT INTO audit.entries
           (company_id, sequence, event_id, event_type, event_version, actor_id, occurred_at, payload, previous_hash, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          entry.companyId,
          entry.sequence,
          entry.eventId,
          entry.eventType,
          entry.eventVersion,
          entry.actorId,
          entry.occurredAt,
          entry.payload,
          previousHash,
          entryHash(previousHash, entry),
        ],
      );
    });
  }

  /**
   * The current company's history, newest change first. Pages continue from the cursor
   * the previous page returned, which combines a time and an entry number.
   */
  listCompany(beforeValue: unknown): Promise<{ entries: AuditEntryView[]; nextBefore: string | null }> {
    const before = cursor(beforeValue);
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<{
        sequence: string;
        event_type: string;
        actor_id: string | null;
        actor_name: string | null;
        occurred_at: Date;
        payload: object;
      }>('SELECT * FROM audit.company_entries($1, $2, $3)', [before?.time ?? null, before?.sequence ?? null, PAGE_SIZE]);
      const entries = rows.map((row) => ({
        sequence: Number(row.sequence),
        eventType: row.event_type,
        actor: row.actor_id === null ? null : { userId: row.actor_id, displayName: row.actor_name },
        occurredAt: row.occurred_at.toISOString(),
        payload: row.payload,
      }));
      const oldest = entries.at(-1);
      return {
        entries,
        nextBefore: entries.length === PAGE_SIZE && oldest !== undefined ? `${oldest.occurredAt}|${oldest.sequence}` : null,
      };
    });
  }

  /** One person's own actions across companies, newest first. */
  async listByActor(actorId: string, beforeValue: unknown): Promise<{ entries: ActorEntryView[]; nextBefore: string | null }> {
    const before = typeof beforeValue === 'string' && !Number.isNaN(Date.parse(beforeValue)) ? beforeValue : null;
    const { rows } = await this.#pool.query<{
      company_id: string;
      company_name: string;
      event_type: string;
      occurred_at: Date;
      payload: object;
    }>('SELECT * FROM audit.actor_entries($1, $2, $3)', [actorId, before, PAGE_SIZE]);
    const entries = rows.map((row) => ({
      companyId: row.company_id,
      companyName: row.company_name,
      eventType: row.event_type,
      occurredAt: row.occurred_at.toISOString(),
      payload: row.payload,
    }));
    return { entries, nextBefore: entries.length === PAGE_SIZE ? (entries.at(-1)?.occurredAt ?? null) : null };
  }

  /** Recomputes the current company's whole chain. */
  verify(): Promise<ChainCheck> {
    return this.#database.transaction(async (tx) => {
      const entries: StoredEntry[] = [];
      for (let after = 0; ; ) {
        const { rows } = await tx.query<EntryRow>(
          'SELECT * FROM audit.entries WHERE sequence > $1 ORDER BY sequence LIMIT $2',
          [after, VERIFY_BATCH],
        );
        entries.push(
          ...rows.map((row) => ({
            companyId: row.company_id,
            sequence: Number(row.sequence),
            eventId: row.event_id,
            eventType: row.event_type,
            eventVersion: row.event_version,
            actorId: row.actor_id,
            occurredAt: row.occurred_at.toISOString(),
            payload: row.payload,
            previousHash: row.previous_hash,
            hash: row.hash,
          })),
        );
        if (rows.length < VERIFY_BATCH) {
          break;
        }
        after = Number(rows.at(-1)!.sequence);
      }
      return verifyChain(entries);
    });
  }
}

function cursor(value: unknown): { time: string; sequence: number } | null {
  if (typeof value !== 'string') {
    return null;
  }
  const [time = '', sequenceText = ''] = value.split('|');
  const sequence = Number(sequenceText);
  return !Number.isNaN(Date.parse(time)) && Number.isInteger(sequence) && sequence > 0 ? { time, sequence } : null;
}
