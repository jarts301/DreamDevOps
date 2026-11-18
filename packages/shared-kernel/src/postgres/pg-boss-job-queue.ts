import { PgBoss } from 'pg-boss';
import {
  deadLetterQueueName,
  type FailedAttempt,
  type JobHandler,
  type JobQueue,
  type QueueOptions,
  UnrecoverableJobError,
  type WorkOptions,
} from '../application/ports.ts';

export interface PgBossJobQueueOptions {
  /** Connection string for the dreamdevops_jobs role. */
  readonly connectionString: string;
  readonly pollingIntervalSeconds?: number;
  /** Errors of the queue itself, such as a lost connection. */
  readonly onError?: (error: unknown) => void;
  /** Each failed try of a job, so it reaches the logs. Without it, failures are kept only in the job's row. */
  readonly onJobFailed?: (failure: FailedAttempt) => void;
}

const BATCH_SIZE = 10;
/** pg-boss's own default: how long a job may run before it's failed and tried again. */
const DEFAULT_EXPIRE_SECONDS = 15 * 60;

/** The pg-boss adapter for the JobQueue port. Its tables live in their own schema. */
export class PgBossJobQueue implements JobQueue {
  readonly #boss: PgBoss;
  readonly #pollingIntervalSeconds: number;
  readonly #onJobFailed: (failure: FailedAttempt) => void;

  private constructor(boss: PgBoss, pollingIntervalSeconds: number, onJobFailed: (failure: FailedAttempt) => void) {
    this.#boss = boss;
    this.#pollingIntervalSeconds = pollingIntervalSeconds;
    this.#onJobFailed = onJobFailed;
  }

  static async start(options: PgBossJobQueueOptions): Promise<PgBossJobQueue> {
    const boss = new PgBoss({ connectionString: options.connectionString, schema: 'pgboss' });
    boss.on('error', options.onError ?? ((error) => console.error('Job queue failed.', error)));
    await boss.start();
    return new PgBossJobQueue(boss, options.pollingIntervalSeconds ?? 2, options.onJobFailed ?? (() => {}));
  }

  /**
   * Creates the queue, or brings an existing one's settings up to date. pg-boss keeps the
   * settings a queue was first created with, so without the update, changed settings, such
   * as a longer timeout, would be silently ignored after the first start.
   */
  async createQueue(queue: string, options: QueueOptions = {}): Promise<void> {
    const deadLetter = deadLetterQueueName(queue);
    await this.#boss.createQueue(deadLetter);
    const settings = {
      retryLimit: options.retryLimit ?? 3,
      retryDelay: options.retryDelaySeconds ?? 30,
      expireInSeconds: options.expireInSeconds ?? DEFAULT_EXPIRE_SECONDS,
    };
    await this.#boss.createQueue(queue, {
      deadLetter,
      ...settings,
      ...(options.heartbeatSeconds !== undefined && { heartbeatSeconds: options.heartbeatSeconds }),
      ...(options.exclusive === true && { policy: 'exclusive' }),
    });
    await this.#boss.updateQueue(queue, { deadLetter, ...settings, heartbeatSeconds: options.heartbeatSeconds ?? null });
  }

  async send(queue: string, data: object, options: { readonly id?: string } = {}): Promise<string | null> {
    return this.#boss.send(queue, data, options.id === undefined ? {} : { id: options.id });
  }

  /**
   * Takes up to 10 jobs at a time and keeps fetching while a backlog remains, instead of
   * waiting a polling interval after every job. Each job succeeds or fails on its own, so
   * one failure never runs the jobs beside it again.
   *
   * With a concurrency, each of that many workers takes one job at a time instead, so a
   * long job never holds others that were fetched with it until they expire.
   *
   * Each handler learns whether it runs the job's last try, and every failed try is
   * reported, so no background failure goes unseen.
   */
  async work(queue: string, handler: JobHandler, options: WorkOptions = {}): Promise<void> {
    const batching: { readonly batchSize: number; readonly burstWhenBatchFull?: boolean; readonly localConcurrency?: number } =
      options.concurrency === undefined
        ? { batchSize: BATCH_SIZE, burstWhenBatchFull: true }
        : { batchSize: 1, localConcurrency: options.concurrency };
    await this.#boss.work(
      queue,
      {
        pollingIntervalSeconds: this.#pollingIntervalSeconds,
        ...batching,
        perJobResults: true,
        // For each job's retry limit, to tell the last try.
        includeMetadata: true,
      },
      async (jobs) => {
        const results: { id: string; status: 'completed' | 'failed'; output?: object }[] = [];
        for (const job of jobs) {
          // Every job this queue sends or publishes carries an object.
          const data = job.data as object;
          const last = job.retryCount >= job.retryLimit;
          try {
            await handler({ id: job.id, data }, { last });
            results.push({ id: job.id, status: 'completed' });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Job failed';
            const unrecoverable = error instanceof UnrecoverableJobError;
            this.#report({ queue, jobId: job.id, error, last: last || unrecoverable });
            if (unrecoverable && (await this.#deadLetter(queue, job.id, data))) {
              results.push({ id: job.id, status: 'completed', output: { deadLettered: message } });
            } else {
              results.push({ id: job.id, status: 'failed', output: { message } });
            }
          }
        }
        return results;
      },
    );
  }

  /** Reports a failed try. A report that fails itself never changes the job's outcome. */
  #report(failure: FailedAttempt): void {
    try {
      this.#onJobFailed(failure);
    } catch {
      // Nothing more can be done: the failure is still kept in the job's row.
    }
  }

  /**
   * Trying again can't help, so the job goes where failed jobs go once their retries run
   * out. Returns false if it couldn't, so the job fails as usual and isn't lost.
   */
  async #deadLetter(queue: string, id: string, data: object): Promise<boolean> {
    try {
      await this.#boss.send(deadLetterQueueName(queue), data, { id });
      return true;
    } catch {
      return false;
    }
  }

  /** pg-boss keeps subscriptions in its own tables, so every process publishing sees them. */
  async subscribe(topic: string, queue: string): Promise<void> {
    await this.#boss.subscribe(topic, queue);
  }

  async publish(topic: string, data: object, options: { readonly id?: string } = {}): Promise<void> {
    await this.#boss.publish(topic, data, options.id === undefined ? {} : { id: options.id });
  }

  /** pg-boss keeps schedules in its own tables, and one process at a time sends their jobs. */
  async schedule(queue: string, cron: string, data: object = {}): Promise<void> {
    await this.#boss.schedule(queue, cron, data, { tz: 'UTC' });
  }

  async stop(): Promise<void> {
    await this.#boss.stop({ graceful: true, timeout: 10_000 });
  }
}
