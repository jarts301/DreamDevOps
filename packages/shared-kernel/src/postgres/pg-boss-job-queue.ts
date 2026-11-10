import { PgBoss } from 'pg-boss';
import { deadLetterQueueName } from '../application/ports.ts';
import type { JobHandler, JobQueue, QueueOptions, WorkOptions } from '../application/ports.ts';

export interface PgBossJobQueueOptions {
  /** Connection string for the dreamdevops_jobs role. */
  readonly connectionString: string;
  readonly pollingIntervalSeconds?: number;
  readonly onError?: (error: unknown) => void;
}

const BATCH_SIZE = 10;
/** pg-boss's own default: how long a job may run before it's failed and tried again. */
const DEFAULT_EXPIRE_SECONDS = 15 * 60;

/** The pg-boss adapter for the JobQueue port. Its tables live in their own schema. */
export class PgBossJobQueue implements JobQueue {
  readonly #boss: PgBoss;
  readonly #pollingIntervalSeconds: number;

  private constructor(boss: PgBoss, pollingIntervalSeconds: number) {
    this.#boss = boss;
    this.#pollingIntervalSeconds = pollingIntervalSeconds;
  }

  static async start(options: PgBossJobQueueOptions): Promise<PgBossJobQueue> {
    const boss = new PgBoss({ connectionString: options.connectionString, schema: 'pgboss' });
    boss.on('error', options.onError ?? ((error) => console.error('Job queue failed.', error)));
    await boss.start();
    return new PgBossJobQueue(boss, options.pollingIntervalSeconds ?? 2);
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
   */
  async work(queue: string, handler: JobHandler, options: WorkOptions = {}): Promise<void> {
    await this.#boss.work<object>(
      queue,
      {
        pollingIntervalSeconds: this.#pollingIntervalSeconds,
        ...(options.concurrency === undefined
          ? { batchSize: BATCH_SIZE, burstWhenBatchFull: true }
          : { batchSize: 1, localConcurrency: options.concurrency }),
        perJobResults: true,
      },
      async (jobs) => {
        const results: { id: string; status: 'completed' | 'failed'; output?: object }[] = [];
        for (const job of jobs) {
          try {
            await handler({ id: job.id, data: job.data });
            results.push({ id: job.id, status: 'completed' });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Job failed';
            results.push({ id: job.id, status: 'failed', output: { message } });
          }
        }
        return results;
      },
    );
  }

  async stop(): Promise<void> {
    await this.#boss.stop({ graceful: true, timeout: 10_000 });
  }
}
