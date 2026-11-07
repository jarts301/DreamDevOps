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
import { AuditLog } from './audit/application/audit-log.ts';
import { AuditController } from './audit/http/audit.controller.ts';
import { InvitationEmails } from './notifications/application/invitation-emails.ts';
import { NotificationRules } from './notifications/application/notification-rules.ts';
import { MAILER, type Mailer, WEBHOOK_SENDER, type WebhookSender } from './notifications/application/ports.ts';
import { NotificationRulesController } from './notifications/http/notification-rules.controller.ts';
import { SafeWebhookSender } from './notifications/infrastructure/safe-webhook-sender.ts';
import { SmtpMailer } from './notifications/infrastructure/smtp-mailer.ts';
import { CompaniesService } from './tenancy/application/companies.service.ts';
import { GIT_PROVIDER, type GitProvider } from './tenancy/application/ports.ts';
import { ProvisioningSaga } from './tenancy/application/provisioning.ts';
import { CompaniesController } from './tenancy/http/companies.controller.ts';
import { ForgejoGitProvider } from './tenancy/infrastructure/forgejo-git-provider.ts';
import { SESSION_STORE } from './session/session-store.ts';
import { ApplicationCatalog } from './catalog/application/application-catalog.ts';
import { ApplicationsController } from './catalog/http/applications.controller.ts';
import { Entitlements } from './editions/application/entitlements.ts';
import { ENTITLEMENT_PROVIDER, type EntitlementProvider } from './editions/application/ports.ts';
import { EditionsController } from './editions/http/editions.controller.ts';
import { FeatureGuard } from './editions/http/feature.guard.ts';
import { CommunityEntitlementProvider } from './editions/infrastructure/community-entitlement-provider.ts';
import { APP_CONFIG, DATABASE_POOL } from './tokens.ts';

const MINUTE_MS = 60_000;

export interface AppModuleOptions {
  readonly config: AppConfig;
  /** Feature controllers. Tests use this to add sample routes. */
  readonly controllers?: readonly Type<unknown>[];
  /** Replaces providers, such as the database, for tests that don't need the real one. */
  readonly overrides?: readonly Provider[];
  /**
   * Decides which commercial features each company has. The Commercial Edition passes
   * its own provider here. Without one, the free Community provider is used.
   */
  readonly entitlementProvider?: EntitlementProvider;
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
        AuditController,
        NotificationRulesController,
        EditionsController,
        ApplicationsController,
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
        {
          provide: AuditLog,
          useFactory: (database: TenantDatabase, pool: pg.Pool) => new AuditLog(database, pool),
          inject: [TenantDatabase, DATABASE_POOL],
        },
        {
          provide: MAILER,
          useFactory: () =>
            new SmtpMailer({
              host: config.smtpHost,
              port: config.smtpPort,
              from: config.smtpFrom,
              security: config.smtpSecurity,
              username: config.smtpUsername,
              password: config.smtpPassword,
            }),
        },
        {
          provide: InvitationEmails,
          useFactory: (mailer: Mailer) => new InvitationEmails(mailer, config.dashboardUrl),
          inject: [MAILER],
        },
        {
          provide: WEBHOOK_SENDER,
          useFactory: () => new SafeWebhookSender({ allowPrivateNetworks: config.webhookAllowPrivateNetworks }),
        },
        {
          provide: NotificationRules,
          useFactory: (database: TenantDatabase, sender: WebhookSender) =>
            new NotificationRules(database, sender, { allowInsecureWebhooks: config.webhookAllowInsecure }),
          inject: [TenantDatabase, WEBHOOK_SENDER],
        },
        { provide: ENTITLEMENT_PROVIDER, useValue: options.entitlementProvider ?? new CommunityEntitlementProvider() },
        {
          provide: Entitlements,
          useFactory: (database: TenantDatabase, provider: EntitlementProvider) => new Entitlements(database, provider),
          inject: [TenantDatabase, ENTITLEMENT_PROVIDER],
        },
        {
          provide: ApplicationCatalog,
          useFactory: (database: TenantDatabase) => new ApplicationCatalog(database),
          inject: [TenantDatabase],
        },
        { provide: BACKGROUND_PROCESSING, useClass: BackgroundProcessing },
        // Guards run in this order, so rate limits apply before any database work.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: OriginGuard },
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: APP_GUARD, useClass: AuthorizationGuard },
        { provide: APP_GUARD, useClass: FeatureGuard },
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
