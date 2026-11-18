import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { BLUEPRINT_CATALOG, type BlueprintCatalog } from '@dreamdevops/contracts/blueprints/services';
import { BlueprintsModule } from '../blueprints/blueprints.module.ts';
import { DEPLOYABLE_IMAGES, type DeployableImages } from '@dreamdevops/contracts/builds/services';
import { BuildsModule } from '../builds/builds.module.ts';
import { APPLICATION_DIRECTORY, type ApplicationDirectory } from '@dreamdevops/contracts/catalog/services';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { FEATURE_ACCESS, type FeatureAccess } from '@dreamdevops/contracts/editions/services';
import { EditionsModule } from '../editions/editions.module.ts';
import { RUNNING_VERSIONS } from '@dreamdevops/contracts/deployments/services';
import {
  ENVIRONMENT_DIRECTORY,
  ENVIRONMENT_GITOPS,
  ENVIRONMENT_VALUES,
  type EnvironmentDirectory,
  type EnvironmentGitOps,
  type EnvironmentValues,
} from '@dreamdevops/contracts/environments/services';
import { EnvironmentsModule } from '../environments/environments.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { REPOSITORY_LOOKUP, type RepositoryLookup } from '@dreamdevops/contracts/source-governance/services';
import { SourceGovernanceModule } from '../source-governance/source-governance.module.ts';
import { Deployments } from './application/deployments.ts';
import { HOST_RUNTIME, type HostRuntime } from './application/ports.ts';
import { LocalDockerRuntime } from './infrastructure/local-docker-runtime.ts';
import { AgentController } from './http/agent.controller.ts';
import { DeploymentsController } from './http/deployments.controller.ts';
import { DeploymentsSubscriptions } from './messaging/deployments-subscriptions.ts';

/**
 * Runs versions of applications in environments, and talks to the agents on targets,
 * which report on rollouts and take promote and abort commands.
 */
@Module({})
export class DeploymentsModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, DeploymentsModule, () => ({
      module: DeploymentsModule,
      imports: [
        BlueprintsModule.register(settings),
        CatalogModule.register(settings),
        SourceGovernanceModule.register(settings),
        BuildsModule.register(settings),
        EditionsModule.register(settings),
        EnvironmentsModule.register(settings),
      ],
      controllers: [DeploymentsController, AgentController],
      providers: withOverrides(
        [
          {
            provide: Deployments,
            useFactory: (
              database: TenantDatabase,
              gitOps: EnvironmentGitOps,
              values: EnvironmentValues,
              environments: EnvironmentDirectory,
              applications: ApplicationDirectory,
              builds: DeployableImages,
              sources: RepositoryLookup,
              blueprints: BlueprintCatalog,
              entitlements: FeatureAccess,
              runtime: HostRuntime,
            ) =>
              new Deployments(
                database,
                gitOps,
                values,
                environments,
                applications,
                builds,
                sources,
                blueprints,
                entitlements,
                runtime,
                {
                  targetRegistryHost: settings.config.targetRegistryHost,
                  targetOtlpEndpoint: settings.config.targetOtlpEndpoint,
                  healthTimeoutMs: settings.config.deployHealthTimeoutSeconds * 1000,
                  localOtlpEndpoint: settings.config.localOtlpEndpoint,
                },
              ),
            inject: [
              TenantDatabase,
              ENVIRONMENT_GITOPS,
              ENVIRONMENT_VALUES,
              ENVIRONMENT_DIRECTORY,
              APPLICATION_DIRECTORY,
              DEPLOYABLE_IMAGES,
              REPOSITORY_LOOKUP,
              BLUEPRINT_CATALOG,
              FEATURE_ACCESS,
              HOST_RUNTIME,
            ],
          },
          {
            // This machine's Docker, which pulls with the platform's registry account only.
            provide: HOST_RUNTIME,
            useFactory: () =>
              new LocalDockerRuntime({
                enabled: settings.config.localHosting,
                registry: {
                  host: new URL(settings.config.forgejoPublicUrl).host,
                  username: settings.config.forgejoUsername,
                  password: settings.config.forgejoPassword,
                },
                bindAddress: settings.config.localHostingBindAddress,
                pullTimeoutMs: settings.config.buildTimeoutMinutes * 60_000,
              }),
          },
          // What other contexts, such as Monitoring, ask about what runs where.
          { provide: RUNNING_VERSIONS, useExisting: Deployments },
          {
            provide: DeploymentsSubscriptions,
            useFactory: (deployments: Deployments) => new DeploymentsSubscriptions(deployments, settings.config),
            inject: [Deployments],
          },
        ],
        settings.overrides,
      ),
      // Monitoring asks what runs, and reads the logs of what runs on This machine.
      exports: [RUNNING_VERSIONS, DeploymentsSubscriptions],
    }));
  }
}
