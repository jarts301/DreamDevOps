import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { APPLICATION_DIRECTORY, type ApplicationDirectory } from '@dreamdevops/contracts/catalog/services';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import {
  REPOSITORY_GIT,
  REPOSITORY_LOOKUP,
  type RepositoryGit,
  type RepositoryLookup,
} from '@dreamdevops/contracts/source-governance/services';
import { SourceGovernanceModule } from '../source-governance/source-governance.module.ts';
import { Builds } from './application/builds.ts';
import {
  BUILDS_STORE,
  type BuildsStore,
  IMAGE_REGISTRY,
  type ImageRegistry,
  PIPELINE_HOST,
  type PipelineHost,
} from './application/ports.ts';
import { BUILD_REQUESTS, DEPLOYABLE_IMAGES, IMAGE_SIGNING_KEYS } from '@dreamdevops/contracts/builds/services';
import { CompanySigningKeys, SigningKeys } from './application/signing-keys.ts';
import { BuildsController } from './http/builds.controller.ts';
import { PipelineController } from './http/pipeline.controller.ts';
import { ForgejoPipelineHost } from './infrastructure/forgejo-pipeline-host.ts';
import { OciRegistry } from './infrastructure/oci-registry.ts';
import { postgresBuildsStore } from './infrastructure/postgres-builds-store.ts';
import { loadPipelines } from './infrastructure/pipeline-files.ts';
import { BuildsSubscriptions } from './messaging/builds-subscriptions.ts';

/** Builds, checks and signs each application's images on the company's isolated runners. */
@Module({})
export class BuildsModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, BuildsModule, () => {
      const { config } = settings;
      const bot = { url: config.forgejoUrl, username: config.forgejoUsername, password: config.forgejoPassword };
      return {
        module: BuildsModule,
        imports: [CatalogModule.register(settings), SourceGovernanceModule.register(settings)],
        controllers: [BuildsController, PipelineController],
        providers: withOverrides(
          [
            {
              provide: IMAGE_REGISTRY,
              useFactory: () => new OciRegistry({ ...bot, imageHost: new URL(config.forgejoPublicUrl).host }),
            },
            { provide: PIPELINE_HOST, useFactory: () => new ForgejoPipelineHost(bot) },
            { provide: SigningKeys, useFactory: () => new SigningKeys(config.signingKeySecret) },
            { provide: BUILDS_STORE, useFactory: postgresBuildsStore, inject: [TenantDatabase] },
            {
              provide: Builds,
              useFactory: (
                store: BuildsStore,
                catalog: ApplicationDirectory,
                repositories: RepositoryLookup,
                host: RepositoryGit,
                registry: ImageRegistry,
                pipelines: PipelineHost,
                keys: SigningKeys,
              ) =>
                new Builds(
                  store,
                  catalog,
                  repositories,
                  host,
                  registry,
                  pipelines,
                  keys,
                  {
                    toolsApiUrl: config.toolsApiUrl,
                    workDir: config.buildWorkDir,
                    timeoutMinutes: config.buildTimeoutMinutes,
                    startTimeoutMinutes: config.buildStartTimeoutMinutes,
                    // Read once at startup, so every build in a run uses the same pipeline.
                    pipelines: loadPipelines(config.pipelinesDir, config.imageRunnerLabel),
                  },
                  new Logger(Builds.name),
                ),
              inject: [BUILDS_STORE, APPLICATION_DIRECTORY, REPOSITORY_LOOKUP, REPOSITORY_GIT, IMAGE_REGISTRY, PIPELINE_HOST, SigningKeys],
            },
            // What other contexts ask Builds for: releases' images, the images deployments run,
            // and the public keys targets check them with.
            { provide: BUILD_REQUESTS, useExisting: Builds },
            { provide: DEPLOYABLE_IMAGES, useExisting: Builds },
            {
              provide: IMAGE_SIGNING_KEYS,
              useFactory: (store: BuildsStore, keys: SigningKeys) => new CompanySigningKeys(store, keys),
              inject: [BUILDS_STORE, SigningKeys],
            },
            {
              provide: BuildsSubscriptions,
              useFactory: (builds: Builds) => new BuildsSubscriptions(builds, config),
              inject: [Builds],
            },
          ],
          settings.overrides,
        ),
        // Releases and deployments ask about builds; targets check images with the company's keys.
        exports: [BUILD_REQUESTS, DEPLOYABLE_IMAGES, IMAGE_SIGNING_KEYS, BuildsSubscriptions],
      };
    });
  }
}
