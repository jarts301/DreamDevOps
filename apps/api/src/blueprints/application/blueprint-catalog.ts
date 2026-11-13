import type { BlueprintFile, BlueprintManifest, ScaffoldValues } from '../domain/blueprint.ts';

export const BLUEPRINT_CATALOG = Symbol('BLUEPRINT_CATALOG');

/**
 * What other modules may ask of the blueprints: which blueprints a type of application can
 * start from, such as React or Vue for a web frontend, and their files, filled in for one
 * application. Where blueprints are kept stays this module's business.
 */
export interface BlueprintCatalog {
  /**
   * The blueprint an application type starts from unless another is chosen: the first of
   * its blueprints by key, in its newest version, or null if it has none.
   */
  latestForType(applicationType: string): BlueprintManifest | null;
  /** Every blueprint an application type can start from, each in its newest version, by language and name. */
  forType(applicationType: string): BlueprintManifest[];
  /** The newest version of one blueprint, or null if there's no such blueprint. */
  latestOf(key: string): BlueprintManifest | null;
  /** A blueprint version's files, with the application's name filled in. */
  render(key: string, version: string, values: ScaffoldValues): BlueprintFile[];
}
