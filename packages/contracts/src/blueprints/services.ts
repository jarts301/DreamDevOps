import type { BlueprintManifest } from './http.ts';

/** What Blueprints answers for other contexts: the versioned scaffolds new applications start from. */

export type { BlueprintManifest } from './http.ts';

/** A file of a scaffold, filled in for one application. */
export interface BlueprintFile {
  readonly path: string;
  readonly content: Buffer;
}

/** The values a scaffold is filled in with. */
export interface ScaffoldValues {
  readonly name: string;
  readonly slug: string;
}

export const BLUEPRINT_CATALOG = Symbol('BLUEPRINT_CATALOG');

/**
 * Which blueprints a type of application can start from, such as React or Vue for a web
 * frontend, and their files, filled in for one application. Where blueprints are kept
 * stays Blueprints' business.
 */
export interface BlueprintCatalog {
  /**
   * The first of an application type's blueprints by key, in its newest version, or null if
   * it has none. Which one a type starts from when none is chosen is the catalog's to say;
   * this is only what's left when it names none.
   */
  latestForType(applicationType: string): BlueprintManifest | null;
  /** Every blueprint an application type can start from, each in its newest version, by language and name. */
  forType(applicationType: string): BlueprintManifest[];
  /** The newest version of one blueprint, or null if there's no such blueprint. */
  latestOf(key: string): BlueprintManifest | null;
  /** One version's manifest, such as the runtime settings deployments use, or null if this platform doesn't have it. */
  manifest(key: string, version: string): BlueprintManifest | null;
  /** A blueprint version's files, with the application's name filled in. */
  render(key: string, version: string, values: ScaffoldValues): BlueprintFile[];
}
