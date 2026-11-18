import type { BlueprintManifest } from '@dreamdevops/contracts/blueprints/services';
import type { BlueprintSource } from './ports.ts';

/** The blueprints every company's applications start from, for anyone who signs in to see. */
export class BlueprintVersions {
  readonly #library: BlueprintSource;

  constructor(library: BlueprintSource) {
    this.#library = library;
  }

  /** Every version, newest first within each blueprint. */
  list(): BlueprintManifest[] {
    return this.#library.all();
  }
}
