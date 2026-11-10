import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type pg from 'pg';
import { DEPLOYABLE_IMAGES, type DeployableImages } from '../builds/application/deployable-images.ts';
import { BuildsModule } from '../builds/builds.module.ts';
import { ApplicationCatalog } from '../catalog/application/application-catalog.ts';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { DATABASE_POOL } from '../tokens.ts';
import { DeploymentPipeline } from './application/deployment-pipeline.ts';
import { Deployments } from './application/deployments.ts';
import { EnvironmentVariables } from './application/environment-variables.ts';
import { Environments } from './application/environments.ts';
import { HostingTargets } from './application/hosting-targets.ts';
import { HOST_RUNTIMES, type HostRuntime, HostRuntimes, SECRET_BOX } from './application/ports.ts';
import type { SecretBox } from './domain/secret-box.ts';
import { DeploymentsController } from './http/deployments.controller.ts';
import { EnvironmentsController } from './http/environments.controller.ts';
import { HostingTargetsController } from './http/hosting-targets.controller.ts';
import { VariablesController } from './http/variables.controller.ts';
import { LocalDockerRuntime } from './infrastructure/local-docker-runtime.ts';
import { loadSecretsKey } from './infrastructure/secrets-key-file.ts';
import { EnvironmentsSubscriptions } from './messaging/environments-subscriptions.ts';

/**
 * Each application's environments, the hosting targets they run on, their variables and
 * secrets, and deployments of the images Builds publishes to them.
 */
@Module({})
export class EnvironmentsModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, EnvironmentsModule, () => {
      const { config } = settings;
      const options = { localHosting: config.localHosting };
      return {
        module: EnvironmentsModule,
        imports: [CatalogModule.register(settings), BuildsModule.register(settings)],
        controllers: [EnvironmentsController, HostingTargetsController, DeploymentsController, VariablesController],
        providers: withOverrides(
          [
            // Loaded once at startup, so a missing or broken key stops the API from starting.
            {
              provide: SECRET_BOX,
              useFactory: () =>
                loadSecretsKey(config.secretsKeyFile, { createIfMissing: config.environment !== 'production' }),
            },
            {
              provide: EnvironmentVariables,
              useFactory: (database: TenantDatabase, catalog: ApplicationCatalog, box: SecretBox) =>
                new EnvironmentVariables(database, catalog, box),
              inject: [TenantDatabase, ApplicationCatalog, SECRET_BOX],
            },
            // One runtime per provider the platform can deploy to. The others come later.
            {
              provide: HOST_RUNTIMES,
              useFactory: (): HostRuntime[] => [
                new LocalDockerRuntime({
                  enabled: config.localHosting,
                  registry: {
                    host: new URL(config.registryUrl).host,
                    username: config.forgejoUsername,
                    password: config.forgejoPassword,
                  },
                  bindAddress: config.localHostingBindAddress,
                  pullTimeoutMs: config.buildTimeoutMs,
                }),
              ],
            },
            {
              provide: HostRuntimes,
              useFactory: (runtimes: readonly HostRuntime[]) => new HostRuntimes(runtimes),
              inject: [HOST_RUNTIMES],
            },
            {
              provide: HostingTargets,
              useFactory: (database: TenantDatabase) => new HostingTargets(database, options),
              inject: [TenantDatabase],
            },
            {
              provide: Environments,
              useFactory: (database: TenantDatabase, catalog: ApplicationCatalog, runtimes: HostRuntimes) =>
                new Environments(database, catalog, runtimes, options),
              inject: [TenantDatabase, ApplicationCatalog, HostRuntimes],
            },
            {
              provide: Deployments,
              useFactory: (
                database: TenantDatabase,
                catalog: ApplicationCatalog,
                images: DeployableImages,
                runtimes: HostRuntimes,
              ) => new Deployments(database, catalog, images, runtimes),
              inject: [TenantDatabase, ApplicationCatalog, DEPLOYABLE_IMAGES, HostRuntimes],
            },
            {
              provide: DeploymentPipeline,
              useFactory: (
                database: TenantDatabase,
                pool: pg.Pool,
                catalog: ApplicationCatalog,
                images: DeployableImages,
                runtimes: HostRuntimes,
                variables: EnvironmentVariables,
              ) =>
                new DeploymentPipeline(database, pool, catalog, images, runtimes, variables, {
                  maxAttempts: config.deployMaxAttempts,
                  healthTimeoutMs: config.deployHealthTimeoutMs,
                }),
              inject: [TenantDatabase, DATABASE_POOL, ApplicationCatalog, DEPLOYABLE_IMAGES, HostRuntimes, EnvironmentVariables],
            },
            {
              provide: EnvironmentsSubscriptions,
              useFactory: (pipeline: DeploymentPipeline) => new EnvironmentsSubscriptions(pipeline, config),
              inject: [DeploymentPipeline],
            },
          ],
          settings.overrides,
        ),
        exports: [EnvironmentsSubscriptions],
      };
    });
  }
}
