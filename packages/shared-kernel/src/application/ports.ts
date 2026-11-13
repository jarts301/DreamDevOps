import type { DomainEvent } from '../domain/domain-event.ts';

export interface Job {
  readonly id: string;
  readonly data: object;
}

export interface QueueOptions {
  /** How many times a failed job runs again before moving to the dead letter queue. */
  readonly retryLimit?: number;
  readonly retryDelaySeconds?: number;
  /**
   * For long jobs: how long one may run before it counts as failed and runs again.
   * Defaults to 15 minutes.
   */
  readonly expireInSeconds?: number;
  /**
   * For long jobs: the worker reports that it's still alive this often, at least every
   * 10 seconds. A job whose worker stops reporting, such as after a crash, runs again
   * soon, while a slow job that's still running keeps going.
   */
  readonly heartbeatSeconds?: number;
}

export interface WorkOptions {
  /**
   * For long jobs: how many run at once in this process, each taken one at a time.
   * Without it, a worker takes small batches and runs them one after another, which
   * suits short jobs.
   */
  readonly concurrency?: number;
}

export type JobHandler = (job: Job) => Promise<void>;

/** Background work. Jobs can run more than once, so handlers must be idempotent. */
export interface JobQueue {
  createQueue(queue: string, options?: QueueOptions): Promise<void>;
  /** Returns the job ID, or null if a job with this ID was already sent. A given ID must be a UUID. */
  send(queue: string, data: object, options?: { readonly id?: string }): Promise<string | null>;
  work(queue: string, handler: JobHandler, options?: WorkOptions): Promise<void>;
  /**
   * Sends a job to the queue on a recurring cron schedule, in UTC, such as every minute
   * with "* * * * *". Every process that shares the queue shares the schedule, so each
   * occurrence sends one job, however many processes run. Scheduling a queue again
   * replaces its schedule, so each start can set it.
   */
  schedule(queue: string, cron: string, data?: object): Promise<void>;
}

/** Receives events leaving the outbox. Delivery is at least once. */
export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export function deadLetterQueueName(queue: string): string {
  return `${queue}.dead`;
}
