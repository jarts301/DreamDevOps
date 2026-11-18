import { Controller, Get, Inject } from '@nestjs/common';
import type { BlueprintManifest } from '@dreamdevops/contracts/blueprints/http';
import { Authenticated } from '../../http/access.decorators.ts';
import { BlueprintVersions } from '../application/blueprint-versions.ts';

/** The blueprints every company's applications start from. Any signed-in user may read them. */
@Controller('blueprints')
export class BlueprintsController {
  readonly #versions: BlueprintVersions;

  constructor(@Inject(BlueprintVersions) versions: BlueprintVersions) {
    this.#versions = versions;
  }

  /** Every version, newest first within each blueprint. */
  @Authenticated()
  @Get()
  list(): BlueprintManifest[] {
    return this.#versions.list();
  }
}
