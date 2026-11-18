import type { EventLog, Transactional } from '../application/persistence.ts';
import type { DomainEvent } from '../domain/domain-event.ts';
import { appendToOutbox } from './outbox.ts';
import type { TenantDatabase, TenantTransaction } from './tenant-database.ts';

/**
 * The base of a context's PostgreSQL session: its queries, run in one tenant transaction,
 * and the events its changes record, saved to the outbox in that same transaction.
 */
export class PostgresSession implements EventLog {
  protected readonly tx: TenantTransaction;

  constructor(tx: TenantTransaction) {
    this.tx = tx;
  }

  record(events: readonly DomainEvent[]): Promise<void> {
    return appendToOutbox(this.tx, events);
  }
}

/** Runs each piece of work in a tenant transaction, with a session made for it. */
export function transactional<TSession>(
  database: TenantDatabase,
  session: (tx: TenantTransaction) => TSession,
): Transactional<TSession> {
  return { transaction: (work) => database.transaction((tx) => work(session(tx))) };
}
