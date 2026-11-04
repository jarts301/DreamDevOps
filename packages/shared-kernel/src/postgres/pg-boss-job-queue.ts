import { PgBoss } from 'pg-boss';
import { deadLetterQueueName } from '../application/ports.ts';
import type { JobHandler, JobQueue, QueueOptions } from '../application/ports.ts';

export interface PgBossJobQueueOptions {
  /** Connection string for the dreamdevops_jobs role. */
  readonly connectionString: string;
  readonly pollingIntervalSeconds?: number;
  readonly onError?: (error: unknown) => void;
}

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

  async work(queue: string, handler: JobHandler): Promise<void> {
    await this.#boss.work<object>(
      queue,
      { pollingIntervalSeconds: this.#pollingIntervalSeconds },
      async (jobs) => {
        for (const job of jobs) {
          await handler({ id: job.id, data: job.data });
        }
      },
    );
  }

  async stop(): Promise<void> {
    await this.#boss.stop({ graceful: true, timeout: 10_000 });
  }
}
