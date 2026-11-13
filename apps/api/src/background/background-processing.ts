import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { EventBus } from '@dreamdevops/shared-kernel';
import { OutboxRelay, PgBossJobQueue } from '@dreamdevops/shared-kernel/postgres';
import pg from 'pg';
import type { AppConfig } from '../config/app-config.ts';
import { APP_CONFIG } from '../tokens.ts';
import { BACKGROUND_SUBSCRIBERS, type BackgroundSubscriber } from './background-subscriber.ts';

export const BACKGROUND_PROCESSING = Symbol('BACKGROUND_PROCESSING');

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
    });
    this.#queue = queue;
    const bus = new EventBus(queue);
    // Every subscription exists before the relay starts, so no event is published to nobody.
    for (const subscriber of this.#subscribers) {
      await subscriber.subscribe({ bus, queue });
    }

    this.#relayPool = new pg.Pool({ connectionString: this.#config.relayDatabaseUrl, max: 2 });
    this.#relay = new OutboxRelay(this.#relayPool, bus, { pollIntervalMs: this.#config.relayPollMs, onError });
    this.#relay.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#relay?.stop();
    await this.#queue?.stop();
    await this.#relayPool?.end();
  }
}

/** Used where nothing should run in the background, such as fast tests. */
export class NoBackgroundProcessing {}
