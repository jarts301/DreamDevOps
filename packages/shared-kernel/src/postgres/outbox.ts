import type { DomainEvent } from '../domain/domain-event.ts';
import { currentCompanyId } from '../application/tenant-context.ts';
import type { TenantTransaction } from './tenant-database.ts';

/**
 * Saves events in the same transaction as the business change, so both are stored
 * or neither is. Row-level security rejects another company's events as a second barrier.
 */
export async function appendToOutbox(
  transaction: TenantTransaction,
  events: readonly DomainEvent[],
): Promise<void> {
  const companyId = currentCompanyId();
  for (const event of events) {
    if (event.companyId !== companyId) {
      throw new CrossTenantEventError();
    }
    await transaction.query(
      `INSERT INTO kernel.outbox (event_id, event_type, event_version, company_id, actor_id, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.eventId,
        event.eventType,
        event.eventVersion,
        event.companyId,
        event.actorId,
        event.occurredAt,
        event.payload,
      ],
    );
  }
}

export class CrossTenantEventError extends Error {
  constructor() {
    super("An event can only be saved in its own company's context.");
    this.name = 'CrossTenantEventError';
  }
}
