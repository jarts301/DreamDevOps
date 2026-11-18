import type { DomainEvent } from '../domain/domain-event.ts';
import { UnrecoverableJobError } from './ports.ts';

/** An event lacks a field its consumer needs, or has one of the wrong kind. Trying again can't fix it. */
export class InvalidEventPayloadError extends UnrecoverableJobError {
  constructor(event: DomainEvent, field: string, expected: string) {
    super(`${event.eventType} ${event.eventId} has no valid "${field}": expected ${expected}.`);
    this.name = 'InvalidEventPayloadError';
  }
}

/**
 * Reads the fields a consumer needs from another module's event. Events cross module
 * boundaries, and later service boundaries, so each consumer checks what it relies on
 * instead of trusting a cast. A missing or malformed field throws InvalidEventPayloadError,
 * which sends the event to the dead letter queue rather than trying it again.
 */
export class EventPayload {
  readonly #event: DomainEvent;
  readonly #fields: Readonly<Record<string, unknown>>;

  constructor(event: DomainEvent) {
    this.#event = event;
    const payload: unknown = event.payload;
    this.#fields = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  }

  /** A field that must be text, and not empty. */
  text(field: string): string {
    const value = this.#fields[field];
    if (typeof value !== 'string' || value === '') {
      throw new InvalidEventPayloadError(this.#event, field, 'text');
    }
    return value;
  }

  /** A field that may be missing or null, and is otherwise text. */
  optionalText(field: string): string | null {
    const value = this.#fields[field];
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new InvalidEventPayloadError(this.#event, field, 'text or nothing');
    }
    return value;
  }

  /** A field that may be missing, which counts as false, and is otherwise true or false. */
  optionalFlag(field: string): boolean {
    const value = this.#fields[field];
    if (value === undefined || value === null) {
      return false;
    }
    if (typeof value !== 'boolean') {
      throw new InvalidEventPayloadError(this.#event, field, 'true or false');
    }
    return value;
  }
}

/** The payload of an event, to read the fields a consumer needs. */
export function payloadOf(event: DomainEvent): EventPayload {
  return new EventPayload(event);
}
