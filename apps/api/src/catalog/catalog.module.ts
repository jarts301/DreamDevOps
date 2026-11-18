import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { BLUEPRINT_CATALOG, type BlueprintCatalog } from '@dreamdevops/contracts/blueprints/services';
import { BlueprintsModule } from '../blueprints/blueprints.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { APPLICATION_DIRECTORY } from '@dreamdevops/contracts/catalog/services';
import { ApplicationCatalog } from './application/application-catalog.ts';
import { CATALOG_STORE, type CatalogStore } from './application/ports.ts';
import { ApplicationsController } from './http/applications.controller.ts';
import { postgresCatalogStore } from './infrastructure/postgres-catalog-store.ts';

/** Each company's register of applications, and the types they can be. */
@Module({})
export class CatalogModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, CatalogModule, () => ({
      module: CatalogModule,
      imports: [BlueprintsModule.register(settings)],
      controllers: [ApplicationsController],
      providers: withOverrides(
        [
          { provide: CATALOG_STORE, useFactory: postgresCatalogStore, inject: [TenantDatabase] },
          {
            provide: ApplicationCatalog,
            useFactory: (store: CatalogStore, blueprints: BlueprintCatalog) => new ApplicationCatalog(store, blueprints),
            inject: [CATALOG_STORE, BLUEPRINT_CATALOG],
          },
          // What other contexts ask about applications through.
          { provide: APPLICATION_DIRECTORY, useExisting: ApplicationCatalog },
        ],
        settings.overrides,
      ),
      // ApplicationCatalog is for the local demo's setup only; contexts use APPLICATION_DIRECTORY.
      exports: [APPLICATION_DIRECTORY, ApplicationCatalog],
    }));
  }
}
