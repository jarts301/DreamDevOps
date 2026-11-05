import {
  type DynamicModule,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
  type Provider,
  type Type,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { EventBus, type JobQueue } from '@dreamdevops/shared-kernel';
import { OutboxRelay, PgBossJobQueue, TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import pg from 'pg';
import { ApplicationTypeRegistry } from './application-catalog/application/application-type-registry.ts';
import { APPLICATION_TYPE_CATALOG } from './application-catalog/catalog/index.ts';
import { ApplicationTypesController } from './application-catalog/http/application-types.controller.ts';
import { BackgroundWork, JOB_QUEUE, OUTBOX_RELAY, RELAY_POOL } from './background/background-work.ts';
import type { AppConfig } from './config/app-config.ts';
import { HealthController } from './health/health.controller.ts';
import { AuthorizationGuard, OriginGuard, SessionGuard } from './http/guards.ts';
import { ProblemDetailsFilter } from './http/problem-details.filter.ts';
import { TenantContextInterceptor } from './http/tenant-context.interceptor.ts';
import { CompanyAccessService } from './identity-access/application/company-access.service.ts';
import { IDENTITY_PROVIDER, USER_DIRECTORY } from './identity-access/application/ports.ts';
import { AuthController } from './identity-access/http/auth.controller.ts';
import {
  CompanyAccessController,
  InvitationsController,
  PlatformCompaniesController,
} from './identity-access/http/company-access.controller.ts';
import { KeycloakIdentityProvider } from './identity-access/infrastructure/keycloak-identity-provider.ts';
import { PostgresUserDirectory } from './identity-access/infrastructure/postgres-user-directory.ts';
import { PostgresSessionStore } from './session/postgres-session-store.ts';
import { SESSION_STORE } from './session/session-store.ts';
import { ApplicationsService } from './tenancy/application/applications.service.ts';
import { CompanyRegistryService } from './tenancy/application/company-registry.service.ts';
import {
  APPLICATION_TYPES,
  type ApplicationTypes,
  GIT_HOSTING,
  type GitHosting,
  SCAFFOLD_RENDERER,
  type ScaffoldRenderer,
} from './tenancy/application/ports.ts';
import { RepositoryService } from './tenancy/application/repositories.service.ts';
import { FileScaffoldTemplates } from './application-catalog/infrastructure/file-scaffold-templates.ts';
import { ProvisioningService } from './tenancy/application/provisioning.service.ts';
import { CompanyController } from './tenancy/http/company.controller.ts';
import { PlatformCompanyRegistryController } from './tenancy/http/platform-companies.controller.ts';
import { ForgejoGitHosting } from './tenancy/infrastructure/forgejo-git-hosting.ts';
import { APP_CONFIG, DATABASE_POOL } from './tokens.ts';

const MINUTE_MS = 60_000;
const backgroundLogger = new Logger('BackgroundWork');

export interface AppModuleOptions {
  readonly config: AppConfig;
  /** Feature controllers. Tests use this to add sample routes. */
  readonly controllers?: readonly Type<unknown>[];
  /** Replaces providers, such as the database, for tests that don't need the real one. */
  readonly overrides?: readonly Provider[];
}

@Module({})
export class AppModule implements OnApplicationShutdown {
  readonly #pool: pg.Pool;
  readonly #relayPool: pg.Pool;

  constructor(@Inject(DATABASE_POOL) pool: pg.Pool, @Inject(RELAY_POOL) relayPool: pg.Pool) {
    this.#pool = pool;
    this.#relayPool = relayPool;
  }

  static forRoot(options: AppModuleOptions): DynamicModule {
    const { config } = options;
    return {
      module: AppModule,
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [
            { name: 'default', ttl: MINUTE_MS, limit: config.rateLimitPerMinute },
            {
              name: 'auth',
              ttl: MINUTE_MS,
              limit: config.authRateLimitPerMinute,
              skipIf: (context) => {
                const controller = context.getClass();
                return controller !== AuthController && controller !== InvitationsController;
              },
            },
          ],
        }),
      ],
      controllers: [
        AuthController,
        CompanyAccessController,
        InvitationsController,
        PlatformCompaniesController,
        PlatformCompanyRegistryController,
        CompanyController,
        ApplicationTypesController,
        HealthController,
        ...(options.controllers ?? []),
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: DATABASE_POOL,
          useFactory: () => new pg.Pool({ connectionString: config.databaseUrl }),
        },
        {
          provide: TenantDatabase,
          useFactory: (pool: pg.Pool) => new TenantDatabase(pool),
          inject: [DATABASE_POOL],
        },
        {
          provide: SESSION_STORE,
          useFactory: (pool: pg.Pool) => new PostgresSessionStore(pool),
          inject: [DATABASE_POOL],
        },
        {
          provide: IDENTITY_PROVIDER,
          useFactory: () =>
            new KeycloakIdentityProvider({
              issuerUrl: config.keycloakIssuerUrl,
              clientId: config.keycloakClientId,
              clientSecret: config.keycloakClientSecret,
            }),
        },
        {
          provide: USER_DIRECTORY,
          useFactory: (pool: pg.Pool) => new PostgresUserDirectory(pool),
          inject: [DATABASE_POOL],
        },
        {
          provide: CompanyAccessService,
          useFactory: (database: TenantDatabase, pool: pg.Pool) =>
            new CompanyAccessService(database, pool, { requireVerifiedEmail: config.requireVerifiedEmail }),
          inject: [TenantDatabase, DATABASE_POOL],
        },
        {
          provide: GIT_HOSTING,
          useFactory: () =>
            new ForgejoGitHosting({
              url: config.forgejoUrl,
              username: config.forgejoUsername,
              password: config.forgejoPassword,
            }),
        },
        {
          provide: CompanyRegistryService,
          useFactory: (database: TenantDatabase, pool: pg.Pool) => new CompanyRegistryService(database, pool),
          inject: [TenantDatabase, DATABASE_POOL],
        },
        // The catalog is checked here, so the API refuses to start with a type that breaks a rule.
        { provide: ApplicationTypeRegistry, useFactory: () => new ApplicationTypeRegistry(APPLICATION_TYPE_CATALOG) },
        { provide: APPLICATION_TYPES, useExisting: ApplicationTypeRegistry },
        // Refuses to start if a scaffold in the catalog has no folder.
        {
          provide: SCAFFOLD_RENDERER,
          useFactory: (registry: ApplicationTypeRegistry) => new FileScaffoldTemplates(registry.scaffoldKeys()),
          inject: [ApplicationTypeRegistry],
        },
        {
          provide: RepositoryService,
          useFactory: (database: TenantDatabase, gitHosting: GitHosting, scaffolds: ScaffoldRenderer, types: ApplicationTypes) =>
            new RepositoryService(database, gitHosting, scaffolds, types),
          inject: [TenantDatabase, GIT_HOSTING, SCAFFOLD_RENDERER, APPLICATION_TYPES],
        },
        {
          provide: ApplicationsService,
          useFactory: (database: TenantDatabase, types: ApplicationTypes) => new ApplicationsService(database, types),
          inject: [TenantDatabase, APPLICATION_TYPES],
        },
        {
          provide: ProvisioningService,
          useFactory: (database: TenantDatabase, gitHosting: GitHosting, repositories: RepositoryService) =>
            new ProvisioningService(database, gitHosting, repositories),
          inject: [TenantDatabase, GIT_HOSTING, RepositoryService],
        },
        // Background work: events leave the outbox through the relay, and the event bus
        // hands each one to its subscribers as jobs.
        {
          provide: RELAY_POOL,
          useFactory: () => new pg.Pool({ connectionString: config.relayDatabaseUrl }),
        },
        {
          provide: JOB_QUEUE,
          useFactory: () =>
            PgBossJobQueue.start({
              connectionString: config.jobsDatabaseUrl,
              onError: (error) => backgroundLogger.error(error),
            }),
        },
        {
          provide: EventBus,
          useFactory: (queue: JobQueue) => new EventBus(queue),
          inject: [JOB_QUEUE],
        },
        {
          provide: OUTBOX_RELAY,
          useFactory: (pool: pg.Pool, bus: EventBus) =>
            new OutboxRelay(pool, bus, { onError: (error) => backgroundLogger.error(error) }),
          inject: [RELAY_POOL, EventBus],
        },
        BackgroundWork,
        // Guards run in this order, so rate limits apply before any database work.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: OriginGuard },
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: APP_GUARD, useClass: AuthorizationGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        ...(options.overrides ?? []),
      ],
    };
  }

  /** Runs after the providers' own shutdown, so background work has stopped using the pools. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.#pool.end(), this.#relayPool.end()]);
  }
}
