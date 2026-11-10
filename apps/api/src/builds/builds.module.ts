import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type pg from 'pg';
import { ApplicationCatalog } from '../catalog/application/application-catalog.ts';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { REPOSITORY_LOOKUP, type RepositoryLookup } from '../source-governance/application/repository-lookup.ts';
import { SourceGovernanceModule } from '../source-governance/source-governance.module.ts';
import { COMPANY_DIRECTORY, type CompanyDirectory } from '../tenancy/application/company-directory.ts';
import { CompanyDirectoryModule } from '../tenancy/company-directory.module.ts';
import { DATABASE_POOL } from '../tokens.ts';
import { BuildPipeline } from './application/build-pipeline.ts';
import { BuildQueries } from './application/build-queries.ts';
import { Builds } from './application/builds.ts';
import { DEPLOYABLE_IMAGES } from './application/deployable-images.ts';
import { PublishedImages } from './application/published-images.ts';
import {
  BUILD_SOURCE,
  type BuildSource,
  IMAGE_BUILDER,
  IMAGE_REGISTRY,
  IMAGE_SCANNER,
  type ImageBuilder,
  type ImageRegistry,
  type ImageScanner,
} from './application/ports.ts';
import { IMAGE_SIGNING_KEY } from './application/tokens.ts';
import type { SigningKey } from './domain/signature.ts';
import { BuildsController } from './http/builds.controller.ts';
import { ForgejoWebhookController } from './http/forgejo-webhook.controller.ts';
import { DockerImageBuilder } from './infrastructure/docker-image-builder.ts';
import { ForgejoBuildSource } from './infrastructure/forgejo-build-source.ts';
import { ForgejoWebhooks } from './infrastructure/forgejo-webhooks.ts';
import { OciRegistry } from './infrastructure/oci-registry.ts';
import { loadSigningKey } from './infrastructure/signing-key-file.ts';
import { NoImageScanner, TrivyImageScanner } from './infrastructure/trivy-image-scanner.ts';
import { BuildsSubscriptions } from './messaging/builds-subscriptions.ts';

/**
 * Versioned, scanned and signed images of each application, and the pipeline that makes
 * them. It offers other contexts the images they can deploy, through DEPLOYABLE_IMAGES.
 */
@Module({})
export class BuildsModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, BuildsModule, () => {
      const { config } = settings;
      const bot = { username: config.forgejoUsername, password: config.forgejoPassword };
      return {
        module: BuildsModule,
        imports: [
          CatalogModule.register(settings),
          CompanyDirectoryModule.register(settings),
          SourceGovernanceModule.register(settings),
        ],
        controllers: [BuildsController, ForgejoWebhookController],
        providers: withOverrides(
          [
            // Loaded once at startup, so a missing or broken key stops the API from starting.
            {
              provide: IMAGE_SIGNING_KEY,
              useFactory: () =>
                loadSigningKey(config.imageSigningKeyFile, { createIfMissing: config.environment !== 'production' }),
            },
            { provide: BUILD_SOURCE, useFactory: () => new ForgejoBuildSource({ url: config.forgejoUrl, ...bot }) },
            { provide: IMAGE_REGISTRY, useFactory: () => new OciRegistry({ url: config.registryUrl, ...bot }) },
            {
              provide: IMAGE_BUILDER,
              useFactory: (registry: ImageRegistry) =>
                new DockerImageBuilder({ registry: { host: registry.host, ...bot }, buildTimeoutMs: config.buildTimeoutMs }),
              inject: [IMAGE_REGISTRY],
            },
            {
              provide: IMAGE_SCANNER,
              useFactory: () =>
                config.imageScanner === 'none'
                  ? new NoImageScanner()
                  : new TrivyImageScanner({ image: config.trivyImage, timeoutMs: config.buildTimeoutMs }),
            },
            {
              provide: Builds,
              useFactory: (
                database: TenantDatabase,
                catalog: ApplicationCatalog,
                repositories: RepositoryLookup,
                source: BuildSource,
              ) =>
                new Builds(database, catalog, repositories, source, {
                  webhookUrl: config.forgejoWebhookUrl,
                  webhookSecret: config.forgejoWebhookSecret,
                }),
              inject: [TenantDatabase, ApplicationCatalog, REPOSITORY_LOOKUP, BUILD_SOURCE],
            },
            {
              provide: BuildQueries,
              useFactory: (
                database: TenantDatabase,
                catalog: ApplicationCatalog,
                repositories: RepositoryLookup,
                source: BuildSource,
              ) => new BuildQueries(database, catalog, repositories, source),
              inject: [TenantDatabase, ApplicationCatalog, REPOSITORY_LOOKUP, BUILD_SOURCE],
            },
            {
              provide: BuildPipeline,
              useFactory: (
                database: TenantDatabase,
                pool: pg.Pool,
                catalog: ApplicationCatalog,
                repositories: RepositoryLookup,
                source: BuildSource,
                builder: ImageBuilder,
                scanner: ImageScanner,
                registry: ImageRegistry,
                key: SigningKey,
              ) =>
                new BuildPipeline(
                  database,
                  pool,
                  catalog,
                  { repositories, source, builder, scanner, registry, key },
                  { maxAttempts: config.buildMaxAttempts, sourceUrl: config.forgejoPublicUrl },
                ),
              inject: [
                TenantDatabase,
                DATABASE_POOL,
                ApplicationCatalog,
                REPOSITORY_LOOKUP,
                BUILD_SOURCE,
                IMAGE_BUILDER,
                IMAGE_SCANNER,
                IMAGE_REGISTRY,
                IMAGE_SIGNING_KEY,
              ],
            },
            {
              provide: DEPLOYABLE_IMAGES,
              useFactory: (database: TenantDatabase, registry: ImageRegistry, key: SigningKey) =>
                new PublishedImages(database, registry, key),
              inject: [TenantDatabase, IMAGE_REGISTRY, IMAGE_SIGNING_KEY],
            },
            {
              provide: ForgejoWebhooks,
              useFactory: (companies: CompanyDirectory, repositories: RepositoryLookup, builds: Builds) =>
                new ForgejoWebhooks(companies, repositories, builds, config.forgejoWebhookSecret),
              inject: [COMPANY_DIRECTORY, REPOSITORY_LOOKUP, Builds],
            },
            {
              provide: BuildsSubscriptions,
              useFactory: (builds: Builds, pipeline: BuildPipeline) => new BuildsSubscriptions(builds, pipeline, config),
              inject: [Builds, BuildPipeline],
            },
          ],
          settings.overrides,
        ),
        // Other contexts use only the images it publishes.
        exports: [BuildsSubscriptions, DEPLOYABLE_IMAGES],
      };
    });
  }
}
