import type { ActivityEntry, AuditEntry, HistoryPage, IntegrityCheck } from '@dreamdevops/contracts/audit/http';
import { describeRecordedEvent } from '@dreamdevops/contracts/events';
import type { CompanyDirectory } from '@dreamdevops/contracts/tenancy/services';
import { currentCompanyId, type DomainEvent, isUuid } from '@dreamdevops/shared-kernel';
import { ChainVerifier, entryHash, GENESIS_HASH } from '../domain/hash-chain.ts';
import type { AuditStore } from './ports.ts';

const PAGE_SIZE = 50;
const VERIFY_BATCH = 1_000;

/** Every company's history of changes. Entries are only ever added. */
export class AuditLog {
  readonly #store: AuditStore;
  readonly #companies: CompanyDirectory;

  constructor(store: AuditStore, companies: CompanyDirectory) {
    this.#store = store;
    this.#companies = companies;
  }

  /** Records an event in its company's history. Runs in the event's company context. */
  async record(event: DomainEvent): Promise<void> {
    await this.#store.transaction(async (session) => {
      // One writer per company at a time, so the chain can't fork.
      await session.lockHistory();
      if (await session.hasEntry(event.eventId)) {
        return;
      }
      const last = await session.lastEntry();
      const previousHash = last?.hash ?? GENESIS_HASH;
      const entry = {
        companyId: currentCompanyId(),
        sequence: (last?.sequence ?? 0) + 1,
        eventId: event.eventId,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        actorId: event.actorId,
        occurredAt: new Date(event.occurredAt).toISOString(),
        payload: event.payload,
      };
      await session.append({ ...entry, previousHash, hash: entryHash(previousHash, entry) });
    });
  }

  /**
   * The current company's history, newest change first. Pages continue from the cursor
   * the previous page returned, which combines a time and an entry number.
   */
  async listCompany(beforeValue: unknown): Promise<HistoryPage<AuditEntry>> {
    const before = cursor(beforeValue);
    const rows = await this.#store.transaction((session) => session.companyEntries(before, PAGE_SIZE));
    const entries = rows.map((row) => ({
      sequence: row.sequence,
      eventType: row.eventType,
      description: describeRecordedEvent(row.eventType, row.payload),
      actor: row.actorId === null ? null : { userId: row.actorId, displayName: row.actorName },
      occurredAt: row.occurredAt.toISOString(),
      payload: row.payload,
    }));
    const oldest = entries.at(-1);
    return {
      entries,
      nextBefore: entries.length === PAGE_SIZE && oldest !== undefined ? `${oldest.occurredAt}|${oldest.sequence}` : null,
    };
  }

  /**
   * One person's own actions across companies, newest first. Pages continue from the cursor
   * the previous page returned, which combines a time and an event ID.
   */
  async listByActor(actorId: string, beforeValue: unknown): Promise<HistoryPage<ActivityEntry>> {
    const rows = await this.#store.actorEntries(actorId, actorCursor(beforeValue), PAGE_SIZE);
    // Company names come from Tenancy, which owns them, once per company on the page.
    const names = new Map<string, string>();
    for (const companyId of new Set(rows.map((row) => row.companyId))) {
      names.set(companyId, (await this.#companies.find(companyId))?.name ?? 'A company that no longer exists');
    }
    const entries = rows.map((row) => ({
      companyId: row.companyId,
      companyName: names.get(row.companyId)!,
      eventType: row.eventType,
      description: describeRecordedEvent(row.eventType, row.payload),
      occurredAt: row.occurredAt.toISOString(),
      payload: row.payload,
    }));
    const oldest = rows.at(-1);
    return {
      entries,
      nextBefore: rows.length === PAGE_SIZE && oldest !== undefined ? `${oldest.occurredAt.toISOString()}|${oldest.eventId}` : null,
    };
  }

  /** Recomputes the current company's whole chain, a batch at a time, so a long history needs little memory. */
  verify(): Promise<IntegrityCheck> {
    return this.#store.transaction(async (session) => {
      const verifier = new ChainVerifier();
      for (let after = 0; ; ) {
        const entries = await session.entriesAfter(after, VERIFY_BATCH);
        for (const entry of entries) {
          if (!verifier.add(entry)) {
            return verifier.result();
          }
        }
        if (entries.length < VERIFY_BATCH) {
          return verifier.result();
        }
        after = entries.at(-1)!.sequence;
      }
    });
  }
}

/**
 * The actor history's cursor: a time and an event ID. A cursor from before event IDs were
 * part of it is just a time, and then continues after every entry of that time.
 */
function actorCursor(value: unknown): { time: string; eventId: string } | null {
  if (typeof value !== 'string') {
    return null;
  }
  const [time = '', eventId] = value.split('|');
  if (Number.isNaN(Date.parse(time))) {
    return null;
  }
  return { time, eventId: eventId !== undefined && isUuid(eventId) ? eventId : 'ffffffff-ffff-ffff-ffff-ffffffffffff' };
}

function cursor(value: unknown): { time: string; sequence: number } | null {
  if (typeof value !== 'string') {
    return null;
  }
  const [time = '', sequenceText = ''] = value.split('|');
  const sequence = Number(sequenceText);
  return !Number.isNaN(Date.parse(time)) && Number.isInteger(sequence) && sequence > 0 ? { time, sequence } : null;
}
