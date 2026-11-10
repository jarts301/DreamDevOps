import { type DynamicModule, Module } from '@nestjs/common';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { BLUEPRINT_CATALOG, type BlueprintCatalog } from '../blueprints/application/blueprint-catalog.ts';
import { BlueprintsModule } from '../blueprints/blueprints.module.ts';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { ApplicationCatalog } from './application/application-catalog.ts';
import { ApplicationsController } from './http/applications.controller.ts';

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
          {
            provide: ApplicationCatalog,
            useFactory: (database: TenantDatabase, blueprints: BlueprintCatalog) => new ApplicationCatalog(database, blueprints),
            inject: [TenantDatabase, BLUEPRINT_CATALOG],
          },
        ],
        settings.overrides,
      ),
      exports: [ApplicationCatalog],
    }));
  }
}
