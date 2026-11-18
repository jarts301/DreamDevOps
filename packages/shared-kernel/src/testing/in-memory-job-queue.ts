import { randomUUID } from 'node:crypto';
import {
  deadLetterQueueName,
  type Job,
  type JobHandler,
  type JobQueue,
  type QueueOptions,
  UnrecoverableJobError,
  type WorkOptions,
} from '../application/ports.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fake JobQueue for fast tests. The same contract tests run against this and pg-boss. */
export class InMemoryJobQueue implements JobQueue {
  readonly #retryLimits = new Map<string, number>();
  readonly #handlers = new Map<string, JobHandler>();
  readonly #seenIds = new Set<string>();
  readonly #deadLetters = new Map<string, Job[]>();
  readonly #schedules = new Map<string, { readonly cron: string; readonly data: object }>();
  /** The queues subscribed to each topic. Shared by everything using this queue, as pg-boss's table is. */
  readonly #subscriptions = new Map<string, Set<string>>();
  /** Exclusive queues, and how many of their jobs are waiting or running. */
  readonly #active = new Map<string, number>();
  #pending: Promise<void> = Promise.resolve();

  async createQueue(queue: string, options: QueueOptions = {}): Promise<void> {
    this.#retryLimits.set(queue, options.retryLimit ?? 3);
    // As in pg-boss, a queue keeps the policy it was first created with.
    if (options.exclusive === true && !this.#active.has(queue)) {
      this.#active.set(queue, 0);
    }
  }

  async send(queue: string, data: object, options: { readonly id?: string } = {}): Promise<string | null> {
    this.#assertQueueExists(queue);
    if (options.id !== undefined && !UUID_PATTERN.test(options.id)) {
      throw new Error('A job ID must be a UUID.');
    }
    const id = options.id ?? randomUUID();
    const key = `${queue}/${id}`;
    if (this.#seenIds.has(key)) {
      return null;
    }
    const active = this.#active.get(queue);
    if (active !== undefined && active > 0) {
      return null;
    }
    this.#seenIds.add(key);
    if (active !== undefined) {
      this.#active.set(queue, active + 1);
    }
    this.#pending = this.#pending.then(async () => {
      try {
        await this.#run(queue, { id, data });
      } finally {
        if (this.#active.has(queue)) {
          this.#active.set(queue, this.#active.get(queue)! - 1);
        }
      }
    });
    return id;
  }

  /** Runs jobs one at a time, in the order they were sent, whatever the concurrency. */
  async work(queue: string, handler: JobHandler, _options?: WorkOptions): Promise<void> {
    this.#assertQueueExists(queue);
    this.#handlers.set(queue, handler);
  }

  async subscribe(topic: string, queue: string): Promise<void> {
    this.#assertQueueExists(queue);
    this.#subscriptions.set(topic, (this.#subscriptions.get(topic) ?? new Set()).add(queue));
  }

  async publish(topic: string, data: object, options: { readonly id?: string } = {}): Promise<void> {
    for (const queue of this.#subscriptions.get(topic) ?? []) {
      await this.send(queue, data, options);
    }
  }

  /** Keeps the schedule. Nothing runs on its own: tests call runSchedules, as if its time came. */
  async schedule(queue: string, cron: string, data: object = {}): Promise<void> {
    this.#assertQueueExists(queue);
    if (cron.trim().split(/\s+/).length !== 5) {
      throw new Error(`"${cron}" isn't a cron expression of five fields.`);
    }
    this.#schedules.set(queue, { cron, data });
  }

  /** Each queue's schedule, by queue. */
  schedulesOf(): ReadonlyMap<string, { readonly cron: string; readonly data: object }> {
    return this.#schedules;
  }

  /** Sends one job for every schedule, as when their time comes, and waits for them to finish. */
  async runSchedules(): Promise<void> {
    for (const [queue, { data }] of this.#schedules) {
      await this.send(queue, data);
    }
    await this.drain();
  }

  /** Waits for all jobs sent so far to finish, including retries, and any jobs they send. */
  async drain(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.#pending;
      await pending;
    } while (pending !== this.#pending);
  }

  deadLettersOf(queue: string): readonly Job[] {
    return this.#deadLetters.get(deadLetterQueueName(queue)) ?? [];
  }

  async #run(queue: string, job: Job): Promise<void> {
    const handler = this.#handlers.get(queue);
    if (handler === undefined) {
      return;
    }
    const attempts = (this.#retryLimits.get(queue) ?? 0) + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await handler(job);
        return;
      } catch (error) {
        // The job runs again until its attempts are used up, unless trying again can't help.
        if (error instanceof UnrecoverableJobError) {
          break;
        }
      }
    }
    const deadLetterQueue = deadLetterQueueName(queue);
    this.#deadLetters.set(deadLetterQueue, [...(this.#deadLetters.get(deadLetterQueue) ?? []), job]);
  }

  #assertQueueExists(queue: string): void {
    if (!this.#retryLimits.has(queue)) {
      throw new Error(`Queue "${queue}" does not exist.`);
    }
  }
}
