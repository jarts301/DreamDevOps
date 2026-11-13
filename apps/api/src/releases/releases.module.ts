import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { Builds } from '../builds/application/builds.ts';
import { BuildsModule } from '../builds/builds.module.ts';
import { ApplicationCatalog } from '../catalog/application/application-catalog.ts';
import { CatalogModule } from '../catalog/catalog.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { SOURCE_HOST, type SourceHost } from '../source-governance/application/ports.ts';
import { REPOSITORY_LOOKUP, type RepositoryLookup } from '../source-governance/application/repository-lookup.ts';
import { SourceGovernanceModule } from '../source-governance/source-governance.module.ts';
import { Releases } from './application/releases.ts';
import { ReleasesController } from './http/releases.controller.ts';
import { ReleasesSubscriptions } from './messaging/releases-subscriptions.ts';

/** Release branches, release candidates and final versions, following Git Flow. */
@Module({})
export class ReleasesModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, ReleasesModule, () => ({
      module: ReleasesModule,
      imports: [CatalogModule.register(settings), SourceGovernanceModule.register(settings), BuildsModule.register(settings)],
      controllers: [ReleasesController],
      providers: withOverrides(
        [
          {
            provide: Releases,
            useFactory: (
              database: TenantDatabase,
              catalog: ApplicationCatalog,
              repositories: RepositoryLookup,
              host: SourceHost,
              builds: Builds,
            ) => new Releases(database, catalog, repositories, host, builds),
            inject: [TenantDatabase, ApplicationCatalog, REPOSITORY_LOOKUP, SOURCE_HOST, Builds],
          },
          {
            provide: ReleasesSubscriptions,
            useFactory: (releases: Releases) => new ReleasesSubscriptions(releases, settings.config),
            inject: [Releases],
          },
        ],
        settings.overrides,
      ),
      exports: [ReleasesSubscriptions],
    }));
  }
}
