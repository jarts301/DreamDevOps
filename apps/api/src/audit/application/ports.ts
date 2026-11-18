import type { Transactional } from '@dreamdevops/shared-kernel';
import type { StoredEntry } from '../domain/hash-chain.ts';

/** An entry of a company's history, as its page shows it. */
export interface CompanyEntry {
  readonly sequence: number;
  readonly eventType: string;
  readonly actorId: string | null;
  /** Who caused it, by name, while they're still known. */
  readonly actorName: string | null;
  readonly occurredAt: Date;
  readonly payload: Record<string, unknown>;
}

/** One of a person's own actions, in whichever company they acted. */
export interface ActorEntry {
  readonly companyId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly payload: Record<string, unknown>;
}

/** The current company's history, in one transaction. */
export interface AuditSession {
  /** Lets one writer at a time add to the company's history, so its chain can't fork. */
  lockHistory(): Promise<void>;
  hasEntry(eventId: string): Promise<boolean>;
  /** The newest entry's number and hash, or null while the history is empty. */
  lastEntry(): Promise<{ readonly sequence: number; readonly hash: string } | null>;
  append(entry: StoredEntry): Promise<void>;
  /** A page of the history, newest change first, before a cursor of a time and an entry number. */
  companyEntries(before: { readonly time: string; readonly sequence: number } | null, limit: number): Promise<CompanyEntry[]>;
  /** Entries after an entry number, in the order they were recorded, with everything their hash covers. */
  entriesAfter(sequence: number, limit: number): Promise<StoredEntry[]>;
}

export const AUDIT_STORE = Symbol('AUDIT_STORE');

export interface AuditStore extends Transactional<AuditSession> {
  /**
   * A page of one person's own actions, across companies, newest first, before a cursor of a
   * time and an event ID. It reads no company's context, only what that person did.
   */
  actorEntries(actorId: string, before: { readonly time: string; readonly eventId: string } | null, limit: number): Promise<ActorEntry[]>;
}
