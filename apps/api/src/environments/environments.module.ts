import { createHmac } from 'node:crypto';
import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { IMAGE_SIGNING_KEYS, type ImageSigningKeys } from '@dreamdevops/contracts/builds/services';
import { BuildsModule } from '../builds/builds.module.ts';
import { APPLICATION_DIRECTORY, type ApplicationDirectory } from '@dreamdevops/contracts/catalog/services';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { SealedBox } from '../shared/sealed-box.ts';
import { COMPANY_DIRECTORY, type CompanyDirectory } from '@dreamdevops/contracts/tenancy/services';
import { CompanyDirectoryModule } from '../tenancy/company-directory.module.ts';
import {
  ENVIRONMENT_DIRECTORY,
  ENVIRONMENT_GITOPS,
  ENVIRONMENT_VALUES,
  TARGET_AUTHENTICATION,
} from '@dreamdevops/contracts/environments/services';
import { EnvironmentConfig } from './application/environment-config.ts';
import { EnvironmentGitOpsService } from './application/environment-gitops.ts';
import { Environments } from './application/environments.ts';
import {
  ENVIRONMENT_REPOSITORIES,
  ENVIRONMENTS_STORE,
  type EnvironmentRepositories,
  type EnvironmentsStore,
  PULL_ACCOUNTS,
  type PullAccounts,
  SECRET_STORE,
  type SecretStore,
} from './application/ports.ts';
import { TargetAgents } from './application/target-agents.ts';
import { TargetConfigurations } from './application/target-configuration.ts';
import { EnvironmentAgentController } from './http/agent.controller.ts';
import { EnvironmentsController } from './http/environments.controller.ts';
import { ForgejoEnvironmentRepositories, ForgejoPullAccounts } from './infrastructure/forgejo-environment-repositories.ts';
import { OpenBaoSecretStore } from './infrastructure/openbao-secret-store.ts';
import { postgresEnvironmentsStore } from './infrastructure/postgres-environments-store.ts';
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
        controllers: [EnvironmentsController, EnvironmentAgentController],
        providers: withOverrides(
          [
            { provide: ENVIRONMENTS_STORE, useFactory: postgresEnvironmentsStore, inject: [TenantDatabase] },
            {
              provide: Environments,
              useFactory: (store: EnvironmentsStore) =>
                new Environments(store, { agentApiUrl: config.agentApiUrl, agentChart: config.agentChart, localHosting: config.localHosting }),
              inject: [ENVIRONMENTS_STORE],
            },
            {
              provide: TargetAgents,
              useFactory: (store: EnvironmentsStore) =>
                new TargetAgents(store, {
                  agentApiUrl: config.agentApiUrl,
                  lostAfterSeconds: config.targetLostAfterSeconds,
                  // Its own key, made from the signing secret, so a telemetry token can never sign anything else.
                  telemetryKey: createHmac('sha256', config.signingKeySecret).update('telemetry-tokens').digest('base64'),
                }),
              inject: [ENVIRONMENTS_STORE],
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
              useFactory: (store: EnvironmentsStore, secrets: SecretStore, applications: ApplicationDirectory) =>
                new EnvironmentConfig(store, secrets, applications),
              inject: [ENVIRONMENTS_STORE, SECRET_STORE, APPLICATION_DIRECTORY],
            },
            {
              provide: TargetConfigurations,
              useFactory: (
                store: EnvironmentsStore,
                companies: CompanyDirectory,
                agents: TargetAgents,
                repositories: EnvironmentRepositories,
                pullAccounts: PullAccounts,
                secrets: SecretStore,
                signingKeys: ImageSigningKeys,
              ) =>
                new TargetConfigurations(
                  store,
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
                    agentApiUrl: config.agentApiUrl,
                  },
                ),
              inject: [ENVIRONMENTS_STORE, COMPANY_DIRECTORY, TargetAgents, ENVIRONMENT_REPOSITORIES, PULL_ACCOUNTS, SECRET_STORE, IMAGE_SIGNING_KEYS],
            },
            // What other contexts ask Environments for: its environments, their values, their
            // repositories, and which target an agent's or collector's token belongs to.
            { provide: ENVIRONMENT_DIRECTORY, useExisting: Environments },
            { provide: ENVIRONMENT_VALUES, useExisting: EnvironmentConfig },
            {
              provide: ENVIRONMENT_GITOPS,
              useFactory: (configurations: TargetConfigurations, repositories: EnvironmentRepositories) =>
                new EnvironmentGitOpsService(configurations, repositories),
              inject: [TargetConfigurations, ENVIRONMENT_REPOSITORIES],
            },
            { provide: TARGET_AUTHENTICATION, useExisting: TargetAgents },
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
        // Environments is for the local demo's setup only; contexts use the published tokens.
        exports: [
          ENVIRONMENT_DIRECTORY,
          ENVIRONMENT_VALUES,
          ENVIRONMENT_GITOPS,
          TARGET_AUTHENTICATION,
          Environments,
          EnvironmentsSubscriptions,
        ],
      };
    });
  }
}
