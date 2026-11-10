import type { EventBus, JobQueue } from '@dreamdevops/shared-kernel';

export const BACKGROUND_SUBSCRIBERS = Symbol('BACKGROUND_SUBSCRIBERS');

/** What a module gets to set up its background work. */
export interface BackgroundWork {
  readonly bus: EventBus;
  readonly queue: JobQueue;
}

/**
 * A module's background work: the events it reacts to, and any queues of its own. Each
 * module owns its subscriptions, so it can later move to its own service with them.
 */
export interface BackgroundSubscriber {
  subscribe(work: BackgroundWork): Promise<void>;
}
