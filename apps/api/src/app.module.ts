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
import { IDENTITY_PROVIDER, USER_DIRECTORY, type UserDirectory } from './identity-access/application/ports.ts';
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Builds } from './builds/application/builds.ts';
import { IMAGE_REGISTRY, type ImageRegistry, PIPELINE_HOST, type PipelineHost } from './builds/application/ports.ts';
import { SigningKeys } from './builds/application/signing-keys.ts';
import { BuildsController } from './builds/http/builds.controller.ts';
import { PipelineController } from './builds/http/pipeline.controller.ts';
import { ForgejoPipelineHost } from './builds/infrastructure/forgejo-pipeline-host.ts';
import { OciRegistry } from './builds/infrastructure/oci-registry.ts';
import { DemoCompany } from './demo/demo-company.ts';
import { Deployments } from './deployments/application/deployments.ts';
import { DeploymentsController } from './deployments/http/deployments.controller.ts';
import { Environments } from './environments/application/environments.ts';
import {
  ENVIRONMENT_REPOSITORIES,
  type EnvironmentRepositories,
  PULL_ACCOUNTS,
  type PullAccounts,
  SECRET_STORE,
  type SecretStore,
} from './environments/application/ports.ts';
import { EnvironmentConfig } from './environments/application/environment-config.ts';
import { TargetConfigurations } from './environments/application/target-configuration.ts';
import { TargetAgents } from './environments/application/target-agents.ts';
import {
  ForgejoEnvironmentRepositories,
  ForgejoPullAccounts,
} from './environments/infrastructure/forgejo-environment-repositories.ts';
import { OpenBaoSecretStore } from './environments/infrastructure/openbao-secret-store.ts';
import { SealedBox } from './shared/sealed-box.ts';
import { AgentController } from './environments/http/agent.controller.ts';
import { EnvironmentsController } from './environments/http/environments.controller.ts';
import { Releases } from './releases/application/releases.ts';
import { ReleasesController } from './releases/http/releases.controller.ts';
import { WebhookGateway } from './webhooks/application/webhook-gateway.ts';
import { webhookSecret } from './webhooks/domain/signature.ts';
import { WebhooksController } from './webhooks/http/webhooks.controller.ts';
import { BlueprintsController } from './blueprints/http/blueprints.controller.ts';
import { BlueprintLibrary } from './blueprints/infrastructure/blueprint-library.ts';
import { SOURCE_HOST, type SourceHost } from './source-governance/application/ports.ts';
import { Repositories } from './source-governance/application/repositories.ts';
import { SourceAccess } from './source-governance/application/source-access.ts';
import { SourceController } from './source-governance/http/source.controller.ts';
import { ForgejoSourceHost } from './source-governance/infrastructure/forgejo-source-host.ts';
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
                return controller !== AuthController && controller !== InvitationsController && controller !== AgentController;
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
        BlueprintsController,
        SourceController,
        WebhooksController,
        BuildsController,
        PipelineController,
        ReleasesController,
        EnvironmentsController,
        AgentController,
        DeploymentsController,
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
        // Loaded once at startup, so a broken or changed blueprint stops the API from starting.
        { provide: BlueprintLibrary, useFactory: () => BlueprintLibrary.load(config.blueprintsDir) },
        {
          provide: ApplicationCatalog,
          useFactory: (database: TenantDatabase, blueprints: BlueprintLibrary) =>
            new ApplicationCatalog(database, blueprints),
          inject: [TenantDatabase, BlueprintLibrary],
        },
        {
          provide: SOURCE_HOST,
          useFactory: () =>
            new ForgejoSourceHost({
              url: config.forgejoUrl,
              username: config.forgejoUsername,
              password: config.forgejoPassword,
            }),
        },
        {
          provide: Repositories,
          useFactory: (
            database: TenantDatabase,
            host: SourceHost,
            catalog: ApplicationCatalog,
            blueprints: BlueprintLibrary,
          ) =>
            new Repositories(database, host, catalog, blueprints, {
              maxAttempts: config.provisioningMaxAttempts,
              publicUrl: config.forgejoPublicUrl,
              webhookUrl: `${config.toolsApiUrl}/api/v1/webhooks/forgejo`,
              webhookSecret: (applicationId) => webhookSecret(config.webhookSecretKey, applicationId),
            }),
          inject: [TenantDatabase, SOURCE_HOST, ApplicationCatalog, BlueprintLibrary],
        },
        {
          provide: WebhookGateway,
          useFactory: (database: TenantDatabase) => new WebhookGateway(database, config.webhookSecretKey),
          inject: [TenantDatabase],
        },
        {
          provide: IMAGE_REGISTRY,
          useFactory: () =>
            new OciRegistry({
              url: config.forgejoUrl,
              imageHost: new URL(config.forgejoPublicUrl).host,
              username: config.forgejoUsername,
              password: config.forgejoPassword,
            }),
        },
        {
          provide: PIPELINE_HOST,
          useFactory: () =>
            new ForgejoPipelineHost({
              url: config.forgejoUrl,
              username: config.forgejoUsername,
              password: config.forgejoPassword,
            }),
        },
        { provide: SigningKeys, useFactory: () => new SigningKeys(config.signingKeySecret) },
        {
          provide: Builds,
          useFactory: (
            database: TenantDatabase,
            catalog: ApplicationCatalog,
            repositories: Repositories,
            host: SourceHost,
            registry: ImageRegistry,
            pipelines: PipelineHost,
            keys: SigningKeys,
          ) =>
            new Builds(database, catalog, repositories, host, registry, pipelines, keys, {
              toolsApiUrl: config.toolsApiUrl,
              workDir: config.buildWorkDir,
              timeoutMinutes: config.buildTimeoutMinutes,
              // Read once at startup, so every build in a run uses the same pipeline.
              pipelines: {
                'build.yaml': readFileSync(join(config.pipelinesDir, 'build.yaml'), 'utf8').replaceAll(
                  '__IMAGE_RUNNER_LABEL__',
                  config.imageRunnerLabel,
                ),
                'check.yaml': readFileSync(join(config.pipelinesDir, 'check.yaml'), 'utf8'),
              },
            }),
          inject: [TenantDatabase, ApplicationCatalog, Repositories, SOURCE_HOST, IMAGE_REGISTRY, PIPELINE_HOST, SigningKeys],
        },
        {
          provide: Releases,
          useFactory: (
            database: TenantDatabase,
            catalog: ApplicationCatalog,
            repositories: Repositories,
            host: SourceHost,
            builds: Builds,
          ) => new Releases(database, catalog, repositories, host, builds),
          inject: [TenantDatabase, ApplicationCatalog, Repositories, SOURCE_HOST, Builds],
        },
        {
          provide: Environments,
          useFactory: (database: TenantDatabase) =>
            new Environments(database, { agentApiUrl: config.agentApiUrl, agentChart: config.agentChart }),
          inject: [TenantDatabase],
        },
        {
          provide: TargetAgents,
          useFactory: (database: TenantDatabase) =>
            new TargetAgents(database, {
              agentApiUrl: config.agentApiUrl,
              lostAfterSeconds: config.targetLostAfterSeconds,
            }),
          inject: [TenantDatabase],
        },
        {
          provide: ENVIRONMENT_REPOSITORIES,
          useFactory: () =>
            new ForgejoEnvironmentRepositories({
              url: config.forgejoUrl,
              bot: { username: config.forgejoUsername, password: config.forgejoPassword },
            }),
        },
        {
          provide: PULL_ACCOUNTS,
          useFactory: () =>
            new ForgejoPullAccounts({
              url: config.forgejoUrl,
              bot: { username: config.forgejoUsername, password: config.forgejoPassword },
              admin: { username: config.forgejoAdminUsername, password: config.forgejoAdminPassword },
            }),
        },
        {
          provide: SECRET_STORE,
          useFactory: () => new OpenBaoSecretStore({ url: config.openbaoUrl, token: config.openbaoToken }),
        },
        {
          provide: EnvironmentConfig,
          useFactory: (database: TenantDatabase, secrets: SecretStore) => new EnvironmentConfig(database, secrets),
          inject: [TenantDatabase, SECRET_STORE],
        },
        {
          provide: TargetConfigurations,
          useFactory: (
            database: TenantDatabase,
            agents: TargetAgents,
            repositories: EnvironmentRepositories,
            pullAccounts: PullAccounts,
            secrets: SecretStore,
            signingKeys: SigningKeys,
          ) =>
            new TargetConfigurations(
              database,
              agents,
              repositories,
              pullAccounts,
              secrets,
              signingKeys,
              new SealedBox(config.signingKeySecret, 'pull-accounts'),
              {
                registryHost: config.targetRegistryHost,
                openbaoUrl: config.targetOpenbaoUrl,
                gitSshUrl: config.targetGitSshUrl,
                gitKnownHosts: config.targetGitKnownHosts,
              },
            ),
          inject: [TenantDatabase, TargetAgents, ENVIRONMENT_REPOSITORIES, PULL_ACCOUNTS, SECRET_STORE, SigningKeys],
        },
        {
          provide: Deployments,
          useFactory: (
            database: TenantDatabase,
            configurations: TargetConfigurations,
            repositories: EnvironmentRepositories,
            environmentConfig: EnvironmentConfig,
            blueprints: BlueprintLibrary,
            entitlements: Entitlements,
          ) =>
            new Deployments(database, configurations, repositories, environmentConfig, blueprints, entitlements, {
              targetRegistryHost: config.targetRegistryHost,
            }),
          inject: [TenantDatabase, TargetConfigurations, ENVIRONMENT_REPOSITORIES, EnvironmentConfig, BlueprintLibrary, Entitlements],
        },
        {
          provide: SourceAccess,
          useFactory: (database: TenantDatabase, host: SourceHost) =>
            new SourceAccess(database, host, config.forgejoPublicUrl),
          inject: [TenantDatabase, SOURCE_HOST],
        },
        { provide: BACKGROUND_PROCESSING, useClass: BackgroundProcessing },
        ...(config.demoData
          ? [
              {
                provide: DemoCompany,
                useFactory: (directory: UserDirectory, companies: CompaniesService, access: CompanyAccessService) =>
                  new DemoCompany(directory, companies, access),
                inject: [USER_DIRECTORY, CompaniesService, CompanyAccessService],
              },
            ]
          : []),
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
