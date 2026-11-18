import { Controller, Get, Inject } from '@nestjs/common';
import type { BlueprintManifest } from '@dreamdevops/contracts/blueprints/http';
import { Authenticated } from '../../http/access.decorators.ts';
import { BlueprintLibrary } from '../infrastructure/blueprint-library.ts';

/** The blueprints every company's applications start from. Any signed-in user may read them. */
@Controller('blueprints')
export class BlueprintsController {
  readonly #library: BlueprintLibrary;

  constructor(@Inject(BlueprintLibrary) library: BlueprintLibrary) {
    this.#library = library;
  }

  /** Every version, newest first within each blueprint. */
  @Authenticated()
  @Get()
  list(): BlueprintManifest[] {
    return this.#library.all();
  }
}
