import { parseCompanyId } from '../domain/company-id.ts';
import type { DomainEvent } from '../domain/domain-event.ts';
import type { EventPublisher, JobQueue, QueueOptions } from './ports.ts';
import { runWithCompany } from './tenant-context.ts';

export type EventHandler<TEvent extends DomainEvent = DomainEvent> = (event: TEvent) => Promise<void>;

const CONSUMER_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Delivers each event to one queue per consumer, so a slow or failing consumer
 * doesn't affect the others. Handlers run inside the event's company context.
 */
export class EventBus implements EventPublisher {
  readonly #queue: JobQueue;
  readonly #queuesByEventType = new Map<string, Set<string>>();
  readonly #queuesForAll = new Set<string>();

  constructor(queue: JobQueue) {
    this.#queue = queue;
  }

  async subscribe<TEvent extends DomainEvent>(
    eventType: TEvent['eventType'],
    consumer: string,
    handler: EventHandler<TEvent>,
    options?: QueueOptions,
  ): Promise<void> {
    if (!CONSUMER_PATTERN.test(consumer)) {
      throw new Error(`Consumer name "${consumer}" must be in kebab-case.`);
    }
    const queueName = `events.${consumer}.${eventType}`;
    const queues = this.#queuesByEventType.get(eventType) ?? new Set<string>();
    if (queues.has(queueName)) {
      throw new Error(`Consumer "${consumer}" already subscribes to ${eventType}.`);
    }

    await this.#queue.createQueue(queueName, options);
    await this.#queue.work(queueName, async (job) => {
      const event = job.data as TEvent;
      await runWithCompany(parseCompanyId(event.companyId), () => handler(event));
    });

    queues.add(queueName);
    this.#queuesByEventType.set(eventType, queues);
  }

  /**
   * Delivers every event, of any type, to one consumer, such as the audit log. Its
   * handler must cope with event types added after it was written.
   */
  async subscribeToAll(consumer: string, handler: EventHandler, options?: QueueOptions): Promise<void> {
    if (!CONSUMER_PATTERN.test(consumer)) {
      throw new Error(`Consumer name "${consumer}" must be in kebab-case.`);
    }
    const queueName = `events.${consumer}.all`;
    if (this.#queuesForAll.has(queueName)) {
      throw new Error(`Consumer "${consumer}" already subscribes to every event.`);
    }
    await this.#queue.createQueue(queueName, options);
    await this.#queue.work(queueName, async (job) => {
      const event = job.data as DomainEvent;
      await runWithCompany(parseCompanyId(event.companyId), () => handler(event));
    });
    this.#queuesForAll.add(queueName);
  }

  async publish(event: DomainEvent): Promise<void> {
    for (const queueName of [...(this.#queuesByEventType.get(event.eventType) ?? []), ...this.#queuesForAll]) {
      await this.#queue.send(queueName, event, { id: event.eventId });
    }
  }
}
