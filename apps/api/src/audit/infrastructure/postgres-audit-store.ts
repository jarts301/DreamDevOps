import { currentCompanyId } from '@dreamdevops/shared-kernel';
import { PostgresSession, type TenantDatabase, transactional } from '@dreamdevops/shared-kernel/postgres';
import type { ActorEntry, AuditSession, AuditStore, CompanyEntry } from '../application/ports.ts';
import type { StoredEntry } from '../domain/hash-chain.ts';

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

/** Each company's history, in the audit schema. Entries are only ever added: the database refuses anything else. */
export function postgresAuditStore(database: TenantDatabase): AuditStore {
  // One person's entries across companies: the function shows only the companies they're in.
  const acrossCompanies = database.acrossCompanies({ role: 'dreamdevops_audit' });
  return {
    ...transactional(database, (tx) => new PostgresAuditSession(tx), { role: 'dreamdevops_audit' }),
    async actorEntries(actorId, before, limit): Promise<ActorEntry[]> {
      const { rows } = await acrossCompanies.query<{
        company_id: string;
        event_id: string;
        event_type: string;
        occurred_at: Date;
        payload: Record<string, unknown>;
      }>('SELECT * FROM audit.actor_entries($1, $2, $3, $4)', [actorId, before?.time ?? null, before?.eventId ?? null, limit]);
      return rows.map((row) => ({
        companyId: row.company_id,
        eventId: row.event_id,
        eventType: row.event_type,
        occurredAt: row.occurred_at,
        payload: row.payload,
      }));
    },
  };
}

class PostgresAuditSession extends PostgresSession implements AuditSession {
  async lockHistory(): Promise<void> {
    await this.tx.query("SELECT pg_advisory_xact_lock(hashtextextended('audit:' || $1, 0))", [currentCompanyId()]);
  }

  async hasEntry(eventId: string): Promise<boolean> {
    const { rows } = await this.tx.query('SELECT 1 FROM audit.entries WHERE event_id = $1', [eventId]);
    return rows.length > 0;
  }

  async lastEntry(): Promise<{ readonly sequence: number; readonly hash: string } | null> {
    const { rows } = await this.tx.query<{ sequence: string; hash: string }>('SELECT sequence, hash FROM audit.entries ORDER BY sequence DESC LIMIT 1');
    return rows[0] === undefined ? null : { sequence: Number(rows[0].sequence), hash: rows[0].hash };
  }

  async append(entry: StoredEntry): Promise<void> {
    await this.tx.query(
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
        entry.previousHash,
        entry.hash,
      ],
    );
  }

  async companyEntries(before: { readonly time: string; readonly sequence: number } | null, limit: number): Promise<CompanyEntry[]> {
    const { rows } = await this.tx.query<{
      sequence: string;
      event_type: string;
      actor_id: string | null;
      actor_name: string | null;
      occurred_at: Date;
      payload: Record<string, unknown>;
    }>('SELECT * FROM audit.company_entries($1, $2, $3)', [before?.time ?? null, before?.sequence ?? null, limit]);
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      eventType: row.event_type,
      actorId: row.actor_id,
      actorName: row.actor_name,
      occurredAt: row.occurred_at,
      payload: row.payload,
    }));
  }

  async entriesAfter(sequence: number, limit: number): Promise<StoredEntry[]> {
    const { rows } = await this.tx.query<EntryRow>('SELECT * FROM audit.entries WHERE sequence > $1 ORDER BY sequence LIMIT $2', [
      sequence,
      limit,
    ]);
    return rows.map((row) => ({
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
    }));
  }
}
