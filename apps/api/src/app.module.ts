import { type DynamicModule, Inject, Module, type OnApplicationShutdown, type Provider, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import pg from 'pg';
import type { AppConfig } from './config/app-config.ts';
import { HealthController } from './health/health.controller.ts';
import { AuthorizationGuard, OriginGuard, SessionGuard } from './http/guards.ts';
import { ProblemDetailsFilter } from './http/problem-details.filter.ts';
import { TenantContextInterceptor } from './http/tenant-context.interceptor.ts';
import { CompanyAccessService } from './identity-access/application/company-access.service.ts';
import { IDENTITY_PROVIDER, USER_DIRECTORY } from './identity-access/application/ports.ts';
import { AuthController } from './identity-access/http/auth.controller.ts';
import { CompanyAccessController, InvitationsController } from './identity-access/http/company-access.controller.ts';
import { KeycloakIdentityProvider } from './identity-access/infrastructure/keycloak-identity-provider.ts';
import { PostgresUserDirectory } from './identity-access/infrastructure/postgres-user-directory.ts';
import { PostgresSessionStore } from './session/postgres-session-store.ts';
import { BACKGROUND_PROCESSING, BackgroundProcessing } from './background/background-processing.ts';
import { CompaniesService } from './tenancy/application/companies.service.ts';
import { GIT_PROVIDER, type GitProvider } from './tenancy/application/ports.ts';
import { ProvisioningSaga } from './tenancy/application/provisioning.ts';
import { CompaniesController } from './tenancy/http/companies.controller.ts';
import { ForgejoGitProvider } from './tenancy/infrastructure/forgejo-git-provider.ts';
import { SESSION_STORE } from './session/session-store.ts';
import { APP_CONFIG, DATABASE_POOL } from './tokens.ts';

const MINUTE_MS = 60_000;

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

  constructor(@Inject(DATABASE_POOL) pool: pg.Pool) {
    this.#pool = pool;
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
        CompaniesController,
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
          provide: CompaniesService,
          useFactory: (database: TenantDatabase, access: CompanyAccessService) => new CompaniesService(database, access),
          inject: [TenantDatabase, CompanyAccessService],
        },
        {
          provide: GIT_PROVIDER,
          useFactory: () =>
            new ForgejoGitProvider({
              url: config.forgejoUrl,
              username: config.forgejoUsername,
              password: config.forgejoPassword,
            }),
        },
        {
          provide: ProvisioningSaga,
          useFactory: (database: TenantDatabase, git: GitProvider) =>
            new ProvisioningSaga(database, git, { maxAttempts: config.provisioningMaxAttempts }),
          inject: [TenantDatabase, GIT_PROVIDER],
        },
        { provide: BACKGROUND_PROCESSING, useClass: BackgroundProcessing },
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

  async onApplicationShutdown(): Promise<void> {
    await this.#pool.end();
  }
}
