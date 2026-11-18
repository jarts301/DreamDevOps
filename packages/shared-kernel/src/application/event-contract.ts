import type { DomainEvent } from '../domain/domain-event.ts';
import { UnrecoverableJobError } from './ports.ts';

/**
 * What a consumer knows of an event it reacts to: its type, its version, and how to check
 * an event against it. The context that publishes an event owns its contract, in the
 * contracts package, so consumers depend on that, never on the publisher's code.
 */
export interface EventContract<TEvent extends DomainEvent = DomainEvent> {
  readonly type: TEvent['eventType'];
  readonly version: number;
  /** The event, checked against the contract. Throws InvalidEventPayloadError when it doesn't hold. */
  parse(event: DomainEvent): TEvent;
}

/**
 * An event doesn't hold to its contract, such as a field that's missing, of the wrong kind,
 * or from a version its consumer doesn't know. Trying again can't fix it, so the event goes
 * to its consumer's dead letter queue.
 */
export class InvalidEventPayloadError extends UnrecoverableJobError {
  constructor(event: Pick<DomainEvent, 'eventType' | 'eventId'>, detail: string) {
    super(`${event.eventType} ${event.eventId} doesn't hold to its contract: ${detail}`);
    this.name = 'InvalidEventPayloadError';
  }
}
