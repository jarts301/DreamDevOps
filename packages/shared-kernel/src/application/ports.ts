import type { DomainEvent } from '../domain/domain-event.ts';

export interface Job {
  readonly id: string;
  readonly data: object;
}

export interface QueueOptions {
  /** How many times a failed job runs again before moving to the dead letter queue. */
  readonly retryLimit?: number;
  readonly retryDelaySeconds?: number;
}

export type JobHandler = (job: Job) => Promise<void>;

/** Background work. Jobs can run more than once, so handlers must be idempotent. */
export interface JobQueue {
  createQueue(queue: string, options?: QueueOptions): Promise<void>;
  /** Returns the job ID, or null if a job with this ID was already sent. A given ID must be a UUID. */
  send(queue: string, data: object, options?: { readonly id?: string }): Promise<string | null>;
  work(queue: string, handler: JobHandler): Promise<void>;
}

/** Receives events leaving the outbox. Delivery is at least once. */
export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export function deadLetterQueueName(queue: string): string {
  return `${queue}.dead`;
}
