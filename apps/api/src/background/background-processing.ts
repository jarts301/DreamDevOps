import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { EventBus } from '@dreamdevops/shared-kernel';
import { OutboxRelay, PgBossJobQueue } from '@dreamdevops/shared-kernel/postgres';
import pg from 'pg';
import { AuditLog } from '../audit/application/audit-log.ts';
import type { AppConfig } from '../config/app-config.ts';
import { DELIVERY_QUEUE, type DeliveryJob, NotificationRules } from '../notifications/application/notification-rules.ts';
import { REPOSITORY_TRIGGERS, Repositories } from '../source-governance/application/repositories.ts';
import { ACCESS_TRIGGERS, SourceAccess } from '../source-governance/application/source-access.ts';
import { PROVISIONING_TRIGGERS, ProvisioningSaga } from '../tenancy/application/provisioning.ts';
import { APP_CONFIG } from '../tokens.ts';

export const BACKGROUND_PROCESSING = Symbol('BACKGROUND_PROCESSING');

/**
 * Delivers saved events to the modules that react to them, by running the outbox relay
 * and the job queue. Each uses its own database role, as the shared kernel requires.
 */
@Injectable()
export class BackgroundProcessing implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #logger = new Logger(BackgroundProcessing.name);
  readonly #config: AppConfig;
  readonly #saga: ProvisioningSaga;
  readonly #audit: AuditLog;
  readonly #notifications: NotificationRules;
  readonly #repositories: Repositories;
  readonly #access: SourceAccess;
  #queue: PgBossJobQueue | undefined;
  #relay: OutboxRelay | undefined;
  #relayPool: pg.Pool | undefined;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(ProvisioningSaga) saga: ProvisioningSaga,
    @Inject(AuditLog) audit: AuditLog,
    @Inject(NotificationRules) notifications: NotificationRules,
    @Inject(Repositories) repositories: Repositories,
    @Inject(SourceAccess) access: SourceAccess,
  ) {
    this.#config = config;
    this.#saga = saga;
    this.#audit = audit;
    this.#notifications = notifications;
    this.#repositories = repositories;
    this.#access = access;
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

    for (const eventType of PROVISIONING_TRIGGERS) {
      await bus.subscribe(eventType, 'tenancy-provisioning', () => this.#saga.reconcile(), {
        retryLimit: this.#config.provisioningMaxAttempts + 2,
        retryDelaySeconds: this.#config.provisioningRetrySeconds,
      });
    }
    const retries = {
      retryLimit: this.#config.provisioningMaxAttempts + 2,
      retryDelaySeconds: this.#config.provisioningRetrySeconds,
    };
    for (const eventType of REPOSITORY_TRIGGERS) {
      await bus.subscribe(
        eventType,
        'source-repositories',
        (event) => this.#repositories.provision((event.payload as { applicationId: string }).applicationId),
        retries,
      );
    }
    for (const [eventType, archived] of [
      ['ApplicationArchived', true],
      ['ApplicationRestored', false],
    ] as const) {
      await bus.subscribe(
        eventType,
        'source-archiving',
        (event) =>
          this.#repositories.syncArchived((event.payload as { applicationId: string }).applicationId, archived),
        retries,
      );
    }
    for (const eventType of ACCESS_TRIGGERS) {
      await bus.subscribe(eventType, 'source-access', () => this.#access.syncCompany(), retries);
    }
    await bus.subscribeToAll('audit', (event) => this.#audit.record(event), { retryLimit: 10, retryDelaySeconds: 5 });
    await bus.subscribeToAll('notifications', (event) => this.#notifications.fanOut(event, queue), {
      retryLimit: 5,
      retryDelaySeconds: 5,
    });
    await queue.createQueue(DELIVERY_QUEUE, {
      retryLimit: 4,
      retryDelaySeconds: this.#config.notificationRetrySeconds,
    });
    await queue.work(DELIVERY_QUEUE, (job) => this.#notifications.deliver(job.data as DeliveryJob));

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
