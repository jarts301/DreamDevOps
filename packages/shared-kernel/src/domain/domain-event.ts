import { randomUUID } from 'node:crypto';
import type { CompanyId } from './company-id.ts';

/** A fact that happened in one company. Payloads must be JSON-serializable. */
export interface DomainEvent<TType extends string = string, TPayload extends object = object> {
  readonly eventId: string;
  readonly eventType: TType;
  readonly eventVersion: number;
  readonly companyId: CompanyId;
  /** The user who caused the event, or null when the platform did it on its own. */
  readonly actorId: string | null;
  readonly occurredAt: string;
  readonly payload: TPayload;
}

export interface NewDomainEvent<TType extends string, TPayload extends object> {
  readonly eventType: TType;
  readonly eventVersion?: number;
  readonly companyId: CompanyId;
  readonly actorId?: string | null;
  readonly payload: TPayload;
  readonly occurredAt?: Date;
  readonly eventId?: string;
}

const EVENT_TYPE_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

export function createDomainEvent<TType extends string, TPayload extends object>(
  event: NewDomainEvent<TType, TPayload>,
): DomainEvent<TType, TPayload> {
  if (!EVENT_TYPE_PATTERN.test(event.eventType)) {
    throw new InvalidDomainEventError(`Event type "${event.eventType}" must be in PascalCase.`);
  }
  const eventVersion = event.eventVersion ?? 1;
  if (!Number.isInteger(eventVersion) || eventVersion < 1) {
    throw new InvalidDomainEventError('Event version must be a positive integer.');
  }
  return Object.freeze({
    eventId: event.eventId ?? randomUUID(),
    eventType: event.eventType,
    eventVersion,
    companyId: event.companyId,
    actorId: event.actorId ?? null,
    occurredAt: (event.occurredAt ?? new Date()).toISOString(),
    payload: event.payload,
  });
}

export class InvalidDomainEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDomainEventError';
  }
}
