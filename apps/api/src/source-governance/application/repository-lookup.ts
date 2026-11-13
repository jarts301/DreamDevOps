import type { RepositorySpec } from './ports.ts';
import type { RepositoryStatus } from './repositories.ts';

export type { RepositorySpec };

export const REPOSITORY_LOOKUP = Symbol('REPOSITORY_LOOKUP');

/** Where an application's repository is, and whether it's ready. */
export interface RepositoryLocation {
  readonly applicationId: string;
  readonly organization: string;
  readonly name: string;
  readonly status: RepositoryStatus;
  /** The blueprint version it was created from, whose runtime settings deployments use. */
  readonly blueprint: { readonly key: string; readonly version: string } | null;
}


/**
 * Source Governance's published read model. Other modules ask here where an
 * application's repository is, instead of reading this module's tables. Both methods
 * run in the current company, so another company's repository is never found.
 */
export interface RepositoryLookup {
  find(applicationId: string): Promise<RepositoryLocation | null>;
  findByName(organization: string, name: string): Promise<RepositoryLocation | null>;
  /** Where an application's repository is, once it's ready. */
  locate(applicationId: string): Promise<RepositorySpec | null>;
  /** The repository's branches, for choosing which to build. Empty until it's ready. */
  branches(applicationId: unknown): Promise<string[]>;
}
