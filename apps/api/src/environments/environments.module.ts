import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { SigningKeys } from '../builds/application/signing-keys.ts';
import { BuildsModule } from '../builds/builds.module.ts';
import { ApplicationCatalog } from '../catalog/application/application-catalog.ts';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { SealedBox } from '../shared/sealed-box.ts';
import { COMPANY_DIRECTORY, type CompanyDirectory } from '../tenancy/application/company-directory.ts';
import { CompanyDirectoryModule } from '../tenancy/company-directory.module.ts';
import { EnvironmentConfig } from './application/environment-config.ts';
import { Environments } from './application/environments.ts';
import {
  ENVIRONMENT_REPOSITORIES,
  type EnvironmentRepositories,
  PULL_ACCOUNTS,
  type PullAccounts,
  SECRET_STORE,
  type SecretStore,
} from './application/ports.ts';
import { TargetAgents } from './application/target-agents.ts';
import { TargetConfigurations } from './application/target-configuration.ts';
import { EnvironmentsController } from './http/environments.controller.ts';
import { ForgejoEnvironmentRepositories, ForgejoPullAccounts } from './infrastructure/forgejo-environment-repositories.ts';
import { OpenBaoSecretStore } from './infrastructure/openbao-secret-store.ts';
import { EnvironmentsSubscriptions } from './messaging/environments-subscriptions.ts';

/** Each company's environments, the targets that run them, and their variables and secrets. */
@Module({})
export class EnvironmentsModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, EnvironmentsModule, () => {
      const { config } = settings;
      const bot = { username: config.forgejoUsername, password: config.forgejoPassword };
      return {
        module: EnvironmentsModule,
        imports: [CatalogModule.register(settings), CompanyDirectoryModule.register(settings), BuildsModule.register(settings)],
        controllers: [EnvironmentsController],
        providers: withOverrides(
          [
            {
              provide: Environments,
              useFactory: (database: TenantDatabase) =>
                new Environments(database, { agentApiUrl: config.agentApiUrl, agentChart: config.agentChart }),
              inject: [TenantDatabase],
            },
            {
              provide: TargetAgents,
              useFactory: (database: TenantDatabase) =>
                new TargetAgents(database, { agentApiUrl: config.agentApiUrl, lostAfterSeconds: config.targetLostAfterSeconds }),
              inject: [TenantDatabase],
            },
            {
              provide: ENVIRONMENT_REPOSITORIES,
              useFactory: () => new ForgejoEnvironmentRepositories({ url: config.forgejoUrl, bot }),
            },
            {
              provide: PULL_ACCOUNTS,
              useFactory: () =>
                new ForgejoPullAccounts({
                  url: config.forgejoUrl,
                  bot,
                  admin: { username: config.forgejoAdminUsername, password: config.forgejoAdminPassword },
                }),
            },
            {
              provide: SECRET_STORE,
              useFactory: () => new OpenBaoSecretStore({ url: config.openbaoUrl, token: config.openbaoToken }),
            },
            {
              provide: EnvironmentConfig,
              useFactory: (database: TenantDatabase, secrets: SecretStore, applications: ApplicationCatalog) =>
                new EnvironmentConfig(database, secrets, applications),
              inject: [TenantDatabase, SECRET_STORE, ApplicationCatalog],
            },
            {
              provide: TargetConfigurations,
              useFactory: (
                database: TenantDatabase,
                companies: CompanyDirectory,
                agents: TargetAgents,
                repositories: EnvironmentRepositories,
                pullAccounts: PullAccounts,
                secrets: SecretStore,
                signingKeys: SigningKeys,
              ) =>
                new TargetConfigurations(
                  database,
                  companies,
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
              inject: [TenantDatabase, COMPANY_DIRECTORY, TargetAgents, ENVIRONMENT_REPOSITORIES, PULL_ACCOUNTS, SECRET_STORE, SigningKeys],
            },
            {
              provide: EnvironmentsSubscriptions,
              useFactory: (agents: TargetAgents, configurations: TargetConfigurations, secrets: SecretStore) =>
                new EnvironmentsSubscriptions(agents, configurations, secrets, config),
              inject: [TargetAgents, TargetConfigurations, SECRET_STORE],
            },
          ],
          settings.overrides,
        ),
        // Deployments run in environments: they write to the environment's repository and
        // read its values, and the agents that report on them are the environments' targets.
        exports: [
          Environments,
          EnvironmentConfig,
          TargetAgents,
          TargetConfigurations,
          ENVIRONMENT_REPOSITORIES,
          EnvironmentsSubscriptions,
        ],
      };
    });
  }
}
