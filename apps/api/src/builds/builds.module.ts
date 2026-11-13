import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { ApplicationCatalog } from '../catalog/application/application-catalog.ts';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { SOURCE_HOST, type SourceHost } from '../source-governance/application/ports.ts';
import { REPOSITORY_LOOKUP, type RepositoryLookup } from '../source-governance/application/repository-lookup.ts';
import { SourceGovernanceModule } from '../source-governance/source-governance.module.ts';
import { Builds } from './application/builds.ts';
import { IMAGE_REGISTRY, type ImageRegistry, PIPELINE_HOST, type PipelineHost } from './application/ports.ts';
import { SigningKeys } from './application/signing-keys.ts';
import { BuildsController } from './http/builds.controller.ts';
import { PipelineController } from './http/pipeline.controller.ts';
import { ForgejoPipelineHost } from './infrastructure/forgejo-pipeline-host.ts';
import { OciRegistry } from './infrastructure/oci-registry.ts';
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
            {
              provide: Builds,
              useFactory: (
                database: TenantDatabase,
                catalog: ApplicationCatalog,
                repositories: RepositoryLookup,
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
                  pipelines: loadPipelines(config.pipelinesDir, config.imageRunnerLabel),
                }),
              inject: [TenantDatabase, ApplicationCatalog, REPOSITORY_LOOKUP, SOURCE_HOST, IMAGE_REGISTRY, PIPELINE_HOST, SigningKeys],
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
        exports: [Builds, SigningKeys, BuildsSubscriptions],
      };
    });
  }
}
