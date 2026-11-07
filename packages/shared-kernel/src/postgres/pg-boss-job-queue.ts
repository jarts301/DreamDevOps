import { PgBoss } from 'pg-boss';
import { deadLetterQueueName } from '../application/ports.ts';
import type { JobHandler, JobQueue, QueueOptions } from '../application/ports.ts';

export interface PgBossJobQueueOptions {
  /** Connection string for the dreamdevops_jobs role. */
  readonly connectionString: string;
  readonly pollingIntervalSeconds?: number;
  readonly onError?: (error: unknown) => void;
}

const BATCH_SIZE = 10;

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

  async createQueue(queue: string, options: QueueOptions = {}): Promise<void> {
    const deadLetter = deadLetterQueueName(queue);
    await this.#boss.createQueue(deadLetter);
    await this.#boss.createQueue(queue, {
      deadLetter,
      retryLimit: options.retryLimit ?? 3,
      retryDelay: options.retryDelaySeconds ?? 30,
    });
  }

  async send(queue: string, data: object, options: { readonly id?: string } = {}): Promise<string | null> {
    return this.#boss.send(queue, data, options.id === undefined ? {} : { id: options.id });
  }

  /**
   * Takes up to 10 jobs at a time and keeps fetching while a backlog remains, instead of
   * waiting a polling interval after every job. Each job succeeds or fails on its own, so
   * one failure never runs the jobs beside it again.
   */
  async work(queue: string, handler: JobHandler): Promise<void> {
    await this.#boss.work<object>(
      queue,
      {
        pollingIntervalSeconds: this.#pollingIntervalSeconds,
        batchSize: BATCH_SIZE,
        burstWhenBatchFull: true,
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
