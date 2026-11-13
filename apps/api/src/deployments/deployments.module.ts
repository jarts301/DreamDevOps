import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { BLUEPRINT_CATALOG, type BlueprintCatalog } from '../blueprints/application/blueprint-catalog.ts';
import { BlueprintsModule } from '../blueprints/blueprints.module.ts';
import { Builds } from '../builds/application/builds.ts';
import { BuildsModule } from '../builds/builds.module.ts';
import { ApplicationCatalog } from '../catalog/application/application-catalog.ts';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { Entitlements } from '../editions/application/entitlements.ts';
import { EditionsModule } from '../editions/editions.module.ts';
import { EnvironmentConfig } from '../environments/application/environment-config.ts';
import { Environments } from '../environments/application/environments.ts';
import { ENVIRONMENT_REPOSITORIES, type EnvironmentRepositories } from '../environments/application/ports.ts';
import { TargetConfigurations } from '../environments/application/target-configuration.ts';
import { EnvironmentsModule } from '../environments/environments.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { REPOSITORY_LOOKUP, type RepositoryLookup } from '../source-governance/application/repository-lookup.ts';
import { SourceGovernanceModule } from '../source-governance/source-governance.module.ts';
import { Deployments } from './application/deployments.ts';
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
              configurations: TargetConfigurations,
              repositories: EnvironmentRepositories,
              environmentConfig: EnvironmentConfig,
              environments: Environments,
              applications: ApplicationCatalog,
              builds: Builds,
              sources: RepositoryLookup,
              blueprints: BlueprintCatalog,
              entitlements: Entitlements,
            ) =>
              new Deployments(
                database,
                configurations,
                repositories,
                environmentConfig,
                environments,
                applications,
                builds,
                sources,
                blueprints,
                entitlements,
                { targetRegistryHost: settings.config.targetRegistryHost },
              ),
            inject: [
              TenantDatabase,
              TargetConfigurations,
              ENVIRONMENT_REPOSITORIES,
              EnvironmentConfig,
              Environments,
              ApplicationCatalog,
              Builds,
              REPOSITORY_LOOKUP,
              BLUEPRINT_CATALOG,
              Entitlements,
            ],
          },
          {
            provide: DeploymentsSubscriptions,
            useFactory: (deployments: Deployments) => new DeploymentsSubscriptions(deployments, settings.config),
            inject: [Deployments],
          },
        ],
        settings.overrides,
      ),
      exports: [DeploymentsSubscriptions],
    }));
  }
}
