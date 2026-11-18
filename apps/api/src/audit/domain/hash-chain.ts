import { createHash } from 'node:crypto';

/** The "previous hash" of a company's first entry. */
export const GENESIS_HASH = '0'.repeat(64);

export interface ChainedEntry {
  readonly companyId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly actorId: string | null;
  /** An ISO 8601 timestamp, normalized with Date.toISOString(). */
  readonly occurredAt: string;
  readonly payload: unknown;
}

export interface StoredEntry extends ChainedEntry {
  readonly previousHash: string;
  readonly hash: string;
}

export interface ChainCheck {
  readonly valid: boolean;
  readonly checked: number;
  /** The first entry that doesn't match, if any. */
  readonly brokenAtSequence: number | null;
  readonly reason: string | null;
}

/**
 * JSON with object keys sorted at every level, so the same content always gives the
 * same text, even after PostgreSQL's jsonb has reordered the keys.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function entryHash(previousHash: string, entry: ChainedEntry): string {
  const content = canonicalJson({
    companyId: entry.companyId,
    sequence: entry.sequence,
    eventId: entry.eventId,
    eventType: entry.eventType,
    eventVersion: entry.eventVersion,
    actorId: entry.actorId,
    occurredAt: entry.occurredAt,
    payload: entry.payload,
  });
  return createHash('sha256').update(`${previousHash}\n${content}`).digest('hex');
}

/**
 * Checks a company's entries one at a time, in sequence order from the first, so a long
 * history can be checked in batches without holding all of it in memory.
 */
export class ChainVerifier {
  #previousHash = GENESIS_HASH;
  #expectedSequence = 1;
  #checked = 0;
  #broken: ChainCheck | null = null;

  /** Checks the next entry. Returns false once the chain is broken, when there's no point going on. */
  add(entry: StoredEntry): boolean {
    if (this.#broken !== null) {
      return false;
    }
    const broken = (reason: string): false => {
      this.#broken = { valid: false, checked: this.#checked, brokenAtSequence: entry.sequence, reason };
      return false;
    };
    if (entry.sequence !== this.#expectedSequence) {
      return broken(`Entry ${this.#expectedSequence} is missing.`);
    }
    if (entry.previousHash !== this.#previousHash) {
      return broken('This entry does not follow the one before it.');
    }
    if (entry.hash !== entryHash(this.#previousHash, entry)) {
      return broken('This entry was changed after it was recorded.');
    }
    this.#previousHash = entry.hash;
    this.#expectedSequence += 1;
    this.#checked += 1;
    return true;
  }

  result(): ChainCheck {
    return this.#broken ?? { valid: true, checked: this.#checked, brokenAtSequence: null, reason: null };
  }
}

/** Checks a company's entries, given in sequence order, from the first one. */
export function verifyChain(entries: Iterable<StoredEntry>): ChainCheck {
  const verifier = new ChainVerifier();
  for (const entry of entries) {
    if (!verifier.add(entry)) {
      break;
    }
  }
  return verifier.result();
}
