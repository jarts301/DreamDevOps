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
  /**
   * At most one job waits or runs at a time, and jobs sent meanwhile are dropped. For
   * recurring sweeps, so a slow one doesn't pile up more behind it. It's set when the queue
   * is first created, and can't be changed later.
   */
  readonly exclusive?: boolean;
}

export interface WorkOptions {
  /**
   * For long jobs: how many run at once in this process, each taken one at a time.
   * Without it, a worker takes small batches and runs them one after another, which
   * suits short jobs.
   */
  readonly concurrency?: number;
}

/**
 * Which try of a job this is. A job that fails is tried again until its retries run out,
 * so only the last try can't count on another: it settles what must not be left waiting,
 * such as marking the work it was doing as failed.
 */
export interface Attempt {
  /** No other try follows this one, whether it succeeds or fails. */
  readonly last: boolean;
}

export type JobHandler = (job: Job, attempt: Attempt) => Promise<void>;

/** A try of a job that failed, for the logs, so a failing background job is never silent. */
export interface FailedAttempt {
  readonly queue: string;
  readonly jobId: string;
  readonly error: unknown;
  /** Whether it was the last try, so the job won't run again. */
  readonly last: boolean;
}

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
  /**
   * Routes every job published to a topic into a queue, from now on. Routes are kept with
   * the jobs, not in memory, so a publisher in any process, such as another instance or
   * another service, reaches every queue that any process subscribed. Subscribing again
   * changes nothing.
   */
  subscribe(topic: string, queue: string): Promise<void>;
  /**
   * Sends a job to every queue subscribed to the topic. A given ID, which must be a UUID,
   * is used in each queue, so publishing the same job again sends nothing new.
   */
  publish(topic: string, data: object, options?: { readonly id?: string }): Promise<void>;
}

/**
 * A job that can never succeed, such as one whose data is malformed. Instead of being
 * tried again, it goes straight to its queue's dead letter queue, where someone can look at it.
 */
export class UnrecoverableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableJobError';
  }
}

/** Receives events leaving the outbox. Delivery is at least once. */
export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export function deadLetterQueueName(queue: string): string {
  return `${queue}.dead`;
}
