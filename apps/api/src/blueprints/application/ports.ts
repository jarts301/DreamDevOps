import type { BlueprintCatalog, BlueprintManifest } from '@dreamdevops/contracts/blueprints/services';

export const BLUEPRINT_SOURCE = Symbol('BLUEPRINT_SOURCE');

/**
 * Where blueprints are kept, such as files shipped with the platform. It answers other
 * contexts' questions, which Blueprints publishes as BlueprintCatalog, and lists every version.
 */
export interface BlueprintSource extends BlueprintCatalog {
  /** Every version of every blueprint, newest first within each blueprint. */
  all(): BlueprintManifest[];
}
