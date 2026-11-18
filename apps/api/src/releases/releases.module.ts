import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { BUILD_REQUESTS, type BuildRequests } from '@dreamdevops/contracts/builds/services';
import { BuildsModule } from '../builds/builds.module.ts';
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
              catalog: ApplicationDirectory,
              repositories: RepositoryLookup,
              host: RepositoryGit,
              builds: BuildRequests,
            ) => new Releases(database, catalog, repositories, host, builds),
            inject: [TenantDatabase, APPLICATION_DIRECTORY, REPOSITORY_LOOKUP, REPOSITORY_GIT, BUILD_REQUESTS],
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
