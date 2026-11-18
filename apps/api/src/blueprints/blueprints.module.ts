import { type DynamicModule, Module } from '@nestjs/common';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { BLUEPRINT_CATALOG } from '@dreamdevops/contracts/blueprints/services';
import { BlueprintVersions } from './application/blueprint-versions.ts';
import { BLUEPRINT_SOURCE, type BlueprintSource } from './application/ports.ts';
import { BlueprintsController } from './http/blueprints.controller.ts';
import { BlueprintLibrary } from './infrastructure/blueprint-library.ts';

/** The versioned scaffolds that new applications start from. */
@Module({})
export class BlueprintsModule {
  static register(settings: ModuleSettings): DynamicModule {
    return registerOnce(settings, BlueprintsModule, () => ({
      module: BlueprintsModule,
      controllers: [BlueprintsController],
      providers: withOverrides(
        // Loaded once at startup, so a broken or changed blueprint stops the API from starting.
        [
          { provide: BLUEPRINT_SOURCE, useFactory: () => BlueprintLibrary.load(settings.config.blueprintsDir) },
          { provide: BLUEPRINT_CATALOG, useExisting: BLUEPRINT_SOURCE },
          {
            provide: BlueprintVersions,
            useFactory: (library: BlueprintSource) => new BlueprintVersions(library),
            inject: [BLUEPRINT_SOURCE],
          },
        ],
        settings.overrides,
      ),
      // Other modules use blueprints only through the BlueprintCatalog interface.
      exports: [BLUEPRINT_CATALOG],
    }));
  }
}
