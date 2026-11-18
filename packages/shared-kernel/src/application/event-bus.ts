import { InvalidCompanyIdError, parseCompanyId } from '../domain/company-id.ts';
import type { DomainEvent } from '../domain/domain-event.ts';
import { type EventContract, InvalidEventPayloadError } from './event-contract.ts';
import { type Attempt, type EventPublisher, type JobQueue, type QueueOptions, UnrecoverableJobError } from './ports.ts';
import { runWithCompany } from './tenant-context.ts';

/**
 * Handles one delivery of an event. A handler that throws gets the event again later,
 * until the queue's retries run out; on the last try, attempt.last is true, so a handler
 * can settle what would otherwise be left waiting, such as failing the work it started.
 */
export type EventHandler<TEvent extends DomainEvent = DomainEvent> = (event: TEvent, attempt: Attempt) => Promise<void>;

const CONSUMER_PATTERN = /^[a-z][a-z0-9-]*$/;

/** The topic every event is published to, for consumers of all events, such as the audit log. */
const ALL_EVENTS_TOPIC = 'events.*';

/**
 * Where events of one type and version go: a topic, and each consumer's queue. Version 1
 * keeps the names events had before versions had their own, so existing queues stay.
 * Each version has its own, so a consumer only ever gets the version its contract reads,
 * and can read two at once while its publisher moves from one to the next.
 */
function suffixOf(eventType: string, version: number): string {
  return version === 1 ? eventType : `${eventType}.v${version}`;
}

function topicOf(eventType: string, version: number): string {
  return `events.${suffixOf(eventType, version)}`;
}

/**
 * Delivers each event to one queue per consumer, so a slow or failing consumer
 * doesn't affect the others. Handlers run inside the event's company context.
 *
 * Which consumer gets which event is kept by the job queue, not in this object, so an
 * event published in one process reaches consumers that subscribed in any other, such
 * as during a rolling deployment, or once a module runs as its own service.
 */
export class EventBus implements EventPublisher {
  readonly #queue: JobQueue;
  /** This process's own subscriptions, only to refuse subscribing twice by mistake. */
  readonly #subscribed = new Set<string>();

  constructor(queue: JobQueue) {
    this.#queue = queue;
  }

  /**
   * Delivers events of one type and version to a consumer, checked against the event's
   * contract first. An event that doesn't hold to it goes to the consumer's dead letter
   * queue, and the handler never sees it. Events of another version of the type go to those
   * who subscribed with that version's contract.
   */
  async subscribe<TEvent extends DomainEvent>(
    contract: EventContract<TEvent>,
    consumer: string,
    handler: EventHandler<TEvent>,
    options?: QueueOptions,
  ): Promise<void> {
    assertConsumerName(consumer);
    const queueName = `events.${consumer}.${suffixOf(contract.type, contract.version)}`;
    if (this.#subscribed.has(queueName)) {
      throw new Error(`Consumer "${consumer}" already subscribes to ${contract.type}, version ${contract.version}.`);
    }
    const topic = topicOf(contract.type, contract.version);
    await this.#listen(queueName, topic, (event, attempt) => handler(checked(contract, event), attempt), options);
  }

  /**
   * Delivers every event, of any type, to one consumer, such as the audit log. Its
   * handler must cope with event types added after it was written.
   */
  async subscribeToAll(consumer: string, handler: EventHandler, options?: QueueOptions): Promise<void> {
    assertConsumerName(consumer);
    const queueName = `events.${consumer}.all`;
    if (this.#subscribed.has(queueName)) {
      throw new Error(`Consumer "${consumer}" already subscribes to every event.`);
    }
    await this.#listen(queueName, ALL_EVENTS_TOPIC, handler, options);
  }

  /** Sends the event to every consumer of its type and version, and of all events, once each, whichever process they're in. */
  async publish(event: DomainEvent): Promise<void> {
    await this.#queue.publish(topicOf(event.eventType, event.eventVersion), event, { id: event.eventId });
    await this.#queue.publish(ALL_EVENTS_TOPIC, event, { id: event.eventId });
  }

  async #listen(queueName: string, topic: string, handler: EventHandler, options: QueueOptions | undefined): Promise<void> {
    this.#subscribed.add(queueName);
    await this.#queue.createQueue(queueName, options);
    await this.#queue.work(queueName, async (job, attempt) => {
      const event = job.data as DomainEvent;
      await runWithCompany(companyOf(event), () => handler(event, attempt));
    });
    await this.#queue.subscribe(topic, queueName);
  }
}

function assertConsumerName(consumer: string): void {
  if (!CONSUMER_PATTERN.test(consumer)) {
    throw new Error(`Consumer name "${consumer}" must be in kebab-case.`);
  }
}

/** The event as its contract reads it. Anything its contract refuses is never tried again. */
function checked<TEvent extends DomainEvent>(contract: EventContract<TEvent>, event: DomainEvent): TEvent {
  try {
    return contract.parse(event);
  } catch (error) {
    if (error instanceof UnrecoverableJobError) {
      throw error;
    }
    throw new InvalidEventPayloadError(event, error instanceof Error ? error.message : 'it could not be read');
  }
}

/** An event without a valid company can never be handled, so it isn't tried again. */
function companyOf(event: DomainEvent): ReturnType<typeof parseCompanyId> {
  try {
    return parseCompanyId(event.companyId);
  } catch (error) {
    if (error instanceof InvalidCompanyIdError) {
      throw new UnrecoverableJobError(`Event ${String(event.eventId)} has no valid company ID.`);
    }
    throw error;
  }
}
