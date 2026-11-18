import type { DomainEvent } from '../domain/domain-event.ts';

/**
 * Records the events a change publishes. They're saved with the change, in its transaction,
 * and published once it commits, so neither happens without the other.
 */
export interface EventLog {
  record(events: readonly DomainEvent[]): Promise<void>;
}

/**
 * A context's data, changed a transaction at a time. Everything the work changes, and every
 * event it records, commits together or not at all. The session holds the context's reads
 * and writes for that one transaction; only its adapter, such as PostgreSQL, knows how the
 * data is kept. Work runs in the current company's context, and sees only its data.
 */
export interface Transactional<TSession> {
  transaction<T>(work: (session: TSession) => Promise<T>): Promise<T>;
}

/**
 * Where application code tells operators what happened, such as a step that failed and
 * will be tried again. The platform supplies its own logger.
 */
export interface Logger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string, stack?: string): void;
}
