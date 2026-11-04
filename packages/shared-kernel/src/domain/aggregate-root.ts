import type { DomainEvent } from './domain-event.ts';

/** Base class for aggregates. Collects events until the application layer saves them. */
export abstract class AggregateRoot {
  #pendingEvents: DomainEvent[] = [];

  protected record(event: DomainEvent): void {
    this.#pendingEvents.push(event);
  }

  /** Returns the recorded events and clears them, so they can't be saved twice. */
  pullEvents(): readonly DomainEvent[] {
    const events = this.#pendingEvents;
    this.#pendingEvents = [];
    return events;
  }
}
