import { type DynamicModule, Module } from '@nestjs/common';
import { type ModuleSettings, registerOnce, withOverrides } from '../platform/module-settings.ts';
import { BLUEPRINT_CATALOG } from './application/blueprint-catalog.ts';
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
          { provide: BlueprintLibrary, useFactory: () => BlueprintLibrary.load(settings.config.blueprintsDir) },
          { provide: BLUEPRINT_CATALOG, useExisting: BlueprintLibrary },
        ],
        settings.overrides,
      ),
      // Other modules use blueprints only through the BlueprintCatalog interface.
      exports: [BLUEPRINT_CATALOG],
    }));
  }
}
