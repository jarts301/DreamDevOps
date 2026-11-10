import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { EventBus, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { OutboxRelay, PgBossJobQueue } from '@dreamdevops/shared-kernel/postgres';
import pg from 'pg';
import { AuditLog } from '../audit/application/audit-log.ts';
import type { AppConfig } from '../config/app-config.ts';
import { DELIVERY_QUEUE, type DeliveryJob, NotificationRules } from '../notifications/application/notification-rules.ts';
import { Builds } from '../builds/application/builds.ts';
import { TargetAgents } from '../environments/application/target-agents.ts';
import { type FinishedBuild, Releases } from '../releases/application/releases.ts';
import { POLICY_VERSION, REPOSITORY_TRIGGERS, Repositories } from '../source-governance/application/repositories.ts';
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
  readonly #builds: Builds;
  readonly #releases: Releases;
  readonly #targets: TargetAgents;
  readonly #database: TenantDatabase;
  #sweep: ReturnType<typeof setInterval> | undefined;
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
    @Inject(Builds) builds: Builds,
    @Inject(Releases) releases: Releases,
    @Inject(TargetAgents) targets: TargetAgents,
    @Inject(TenantDatabase) database: TenantDatabase,
  ) {
    this.#config = config;
    this.#saga = saga;
    this.#audit = audit;
    this.#notifications = notifications;
    this.#repositories = repositories;
    this.#access = access;
    this.#builds = builds;
    this.#releases = releases;
    this.#targets = targets;
    this.#database = database;
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
    type Payload = Record<string, unknown>;
    const payloadOf = (event: { payload: object }) => event.payload as Payload;
    await bus.subscribe('BuildRequested', 'builds', (event) => this.#builds.start(String(payloadOf(event).buildId)), {
      retryLimit: 3,
      retryDelaySeconds: 10,
    });
    await bus.subscribe(
      'BranchDeleted',
      'builds-cleanup',
      async (event) => {
        const { applicationId, branch } = payloadOf(event);
        if (typeof branch === 'string' && branch.startsWith('feature/')) {
          await this.#builds.removeFeatureImages(String(applicationId), branch);
        }
      },
      retries,
    );
    await bus.subscribe('ReleaseStarted', 'releases', (event) => this.#releases.prepare(String(payloadOf(event).releaseId)), retries);
    await bus.subscribe(
      'CodePushed',
      'releases',
      (event) => this.#releases.onCodePushed(payloadOf(event) as { applicationId: string; branch: string; after: string }),
      retries,
    );
    await bus.subscribe(
      'PullRequestMerged',
      'releases',
      (event) =>
        this.#releases.onPullRequestMerged(
          payloadOf(event) as { applicationId: string; head: string; base: string; mergeCommit: string },
        ),
      retries,
    );
    await bus.subscribe(
      'PullRequestUpdated',
      'pull-request-checks',
      (event) => {
        const { applicationId, head, headCommit } = payloadOf(event);
        return this.#builds.requestCheck(String(applicationId), String(head), String(headCommit));
      },
      retries,
    );
    for (const [eventType, succeeded] of [
      ['BuildSucceeded', true],
      ['BuildFailed', false],
    ] as const) {
      await bus.subscribe(
        eventType,
        'pull-request-checks',
        (event) => {
          const { kind, applicationId, commit, reason } = payloadOf(event);
          return this.#builds.reportCheck(
            {
              kind: String(kind),
              applicationId: String(applicationId),
              commit: String(commit),
              reason: typeof reason === 'string' ? reason : undefined,
            },
            succeeded,
          );
        },
        retries,
      );
      await bus.subscribe(
        eventType,
        'releases',
        (event) => this.#releases.onBuildFinished(payloadOf(event) as unknown as FinishedBuild, succeeded),
        retries,
      );
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

    // Builds whose jobs died without reporting are failed once they pass the timeout, and
    // targets that stopped reporting are marked as lost.
    this.#sweep = setInterval(() => {
      this.#builds.expireStale().catch(onError);
      this.#targets.markSilentTargetsLost().catch(onError);
    }, 30_000);
    await this.#upgradeRepositories().catch(onError);
  }

  /** Brings repositories made under older rules up to date, company by company. */
  async #upgradeRepositories(): Promise<void> {
    const companies = await runWithCompany(parseCompanyId('00000000-0000-0000-0000-000000000000'), () =>
      this.#database.transaction(async (tx) => {
        const { rows } = await tx.query<{ company_id: string }>(
          'SELECT * FROM source.companies_with_outdated_repositories($1)',
          [POLICY_VERSION],
        );
        return rows;
      }),
    );
    for (const { company_id: companyId } of companies) {
      await runWithCompany(parseCompanyId(companyId), () => this.#repositories.upgradePolicies()).catch((error) =>
        this.#logger.error(`Upgrading the repositories of ${companyId} failed: ${String(error)}`),
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.#sweep);
    await this.#relay?.stop();
    await this.#queue?.stop();
    await this.#relayPool?.end();
  }
}

/** Used where nothing should run in the background, such as fast tests. */
export class NoBackgroundProcessing {}
