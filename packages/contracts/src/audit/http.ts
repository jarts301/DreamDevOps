/** The audit log's HTTP API, as the dashboard sees it. Types only, so a browser app can use them. */

/** Someone who caused a change, by name while they're still known. */
export interface AuditActor {
  readonly userId: string;
  readonly displayName: string | null;
}

/** One change in the current company's history. */
export interface AuditEntry {
  readonly sequence: number;
  readonly eventType: string;
  /** The change in words, as its event's contract tells it, such as 'Registered the application "Billing API"'. */
  readonly description: string;
  /** Null when the platform made the change on its own. */
  readonly actor: AuditActor | null;
  readonly occurredAt: string;
  /** The event as recorded. Its shape is its event's contract, at the version it was recorded with. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** One of a person's own actions, in any company they acted on. */
export interface ActivityEntry {
  readonly companyId: string;
  readonly companyName: string;
  readonly eventType: string;
  /** The change in words, as its event's contract tells it. */
  readonly description: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** A page of a history, newest first. */
export interface HistoryPage<TEntry> {
  readonly entries: readonly TEntry[];
  /** Asks for the next, older page. Null on the last page. */
  readonly nextBefore: string | null;
}

/** Whether the company's history is intact: each entry's hash covers it and the one before. */
export interface IntegrityCheck {
  readonly valid: boolean;
  readonly checked: number;
  /** The first entry that doesn't match, if any. */
  readonly brokenAtSequence: number | null;
  readonly reason: string | null;
}
