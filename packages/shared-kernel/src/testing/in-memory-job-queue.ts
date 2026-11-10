import { randomUUID } from 'node:crypto';
import { deadLetterQueueName } from '../application/ports.ts';
import type { Job, JobHandler, JobQueue, QueueOptions, WorkOptions } from '../application/ports.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fake JobQueue for fast tests. The same contract tests run against this and pg-boss. */
export class InMemoryJobQueue implements JobQueue {
  readonly #retryLimits = new Map<string, number>();
  readonly #handlers = new Map<string, JobHandler>();
  readonly #seenIds = new Set<string>();
  readonly #deadLetters = new Map<string, Job[]>();
  #pending: Promise<void> = Promise.resolve();

  async createQueue(queue: string, options: QueueOptions = {}): Promise<void> {
    this.#retryLimits.set(queue, options.retryLimit ?? 3);
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
    this.#seenIds.add(key);
    this.#pending = this.#pending.then(() => this.#run(queue, { id, data }));
    return id;
  }

  /** Runs jobs one at a time, in the order they were sent, whatever the concurrency. */
  async work(queue: string, handler: JobHandler, _options?: WorkOptions): Promise<void> {
    this.#assertQueueExists(queue);
    this.#handlers.set(queue, handler);
  }

  /** Waits for all jobs sent so far to finish, including retries. */
  async drain(): Promise<void> {
    await this.#pending;
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
      } catch {
        // The job runs again until its attempts are used up.
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
