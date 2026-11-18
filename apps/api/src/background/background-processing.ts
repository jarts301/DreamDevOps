import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { describeError, EventBus, type FailedAttempt } from '@dreamdevops/shared-kernel';
import { OutboxRelay, PgBossJobQueue } from '@dreamdevops/shared-kernel/postgres';
import pg from 'pg';
import type { AppConfig } from '../config/app-config.ts';
import { APP_CONFIG } from '../tokens.ts';
import { BACKGROUND_SUBSCRIBERS, type BackgroundSubscriber } from './background-subscriber.ts';

export const BACKGROUND_PROCESSING = Symbol('BACKGROUND_PROCESSING');

/** Removes events from the outbox once they've been delivered for a while. */
export const OUTBOX_RETENTION_QUEUE = 'kernel.outbox-retention';
/** Every day at 03:17 UTC, a quiet time, on a schedule every API process shares. */
const OUTBOX_RETENTION_SCHEDULE = '17 3 * * *';
const DAY_MS = 86_400_000;

/**
 * Delivers saved events to the modules that react to them, by running the outbox relay
 * and the job queue. Each uses its own database role, as the shared kernel requires.
 * What each module reacts to is up to the module: this only starts the machinery.
 */
@Injectable()
export class BackgroundProcessing implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #logger = new Logger(BackgroundProcessing.name);
  readonly #config: AppConfig;
  readonly #subscribers: readonly BackgroundSubscriber[];
  #queue: PgBossJobQueue | undefined;
  #relay: OutboxRelay | undefined;
  #relayPool: pg.Pool | undefined;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(BACKGROUND_SUBSCRIBERS) subscribers: readonly BackgroundSubscriber[],
  ) {
    this.#config = config;
    this.#subscribers = subscribers;
  }

  async onApplicationBootstrap(): Promise<void> {
    const onError = (error: unknown) => this.#logger.error(error);
    const queue = await PgBossJobQueue.start({
      connectionString: this.#config.jobsDatabaseUrl,
      pollingIntervalSeconds: this.#config.jobPollingSeconds,
      onError,
      onJobFailed: (failure) => this.#logFailure(failure),
    });
    this.#queue = queue;
    const bus = new EventBus(queue);
    // Every subscription exists before the relay starts, so no event is published to nobody.
    for (const subscriber of this.#subscribers) {
      await subscriber.subscribe({ bus, queue });
    }

    this.#relayPool = new pg.Pool({ connectionString: this.#config.relayDatabaseUrl, max: 2 });
    const relay = new OutboxRelay(this.#relayPool, bus, { pollIntervalMs: this.#config.relayPollMs, onError });
    this.#relay = relay;
    relay.start();

    // Without this, the outbox keeps every event ever saved. The audit log keeps them for good.
    await queue.createQueue(OUTBOX_RETENTION_QUEUE, { retryLimit: 2, retryDelaySeconds: 300, exclusive: true, expireInSeconds: 3_600 });
    await queue.work(OUTBOX_RETENTION_QUEUE, async () => {
      const removed = await relay.purgePublished(new Date(Date.now() - this.#config.outboxRetentionDays * DAY_MS));
      if (removed > 0) {
        this.#logger.log(`Removed ${removed} delivered events from the outbox.`);
      }
    });
    await queue.schedule(OUTBOX_RETENTION_QUEUE, OUTBOX_RETENTION_SCHEDULE);
  }

  /**
   * Every failed try of a background job, such as a build that couldn't start. A try that
   * will be repeated is a warning; the last one is an error, since its work stops there.
   */
  #logFailure({ queue, jobId, error, last }: FailedAttempt): void {
    if (last) {
      this.#logger.error(`Job ${jobId} in ${queue} failed for the last time: ${describeError(error)}`);
    } else {
      this.#logger.warn(`Job ${jobId} in ${queue} failed, and will be tried again: ${describeError(error)}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#relay?.stop();
    await this.#queue?.stop();
    await this.#relayPool?.end();
  }
}

/** Used where nothing should run in the background, such as fast tests. */
export class NoBackgroundProcessing {}
