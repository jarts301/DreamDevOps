import type { BlueprintFile, BlueprintManifest, ScaffoldValues } from '../domain/blueprint.ts';

export const BLUEPRINT_CATALOG = Symbol('BLUEPRINT_CATALOG');

/**
 * What other modules may ask of the blueprints: which blueprint a type of application
 * starts from, and its files, filled in for one application. Where blueprints are kept
 * stays this module's business.
 */
export interface BlueprintCatalog {
  /** The newest blueprint for an application type, or null if it has none. */
  latestForType(applicationType: string): BlueprintManifest | null;
  /** A blueprint version's files, with the application's name filled in. */
  render(key: string, version: string, values: ScaffoldValues): BlueprintFile[];
}
