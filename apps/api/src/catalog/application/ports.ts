import type { EventLog, Transactional } from '@dreamdevops/shared-kernel';
import type { ApplicationStatus } from '../domain/application.ts';

/** An application as the catalog keeps it. */
export interface StoredApplication {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly typeKey: string;
  readonly typeName: string;
  readonly blueprintKey: string;
  readonly description: string;
  readonly status: ApplicationStatus;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  /** Who registered it, by name, while they're still known. */
  readonly creatorName: string | null;
  readonly archivedAt: Date | null;
}

/** A type of application a company can register. */
export interface StoredApplicationType {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** The blueprint applications of the type start from when none is chosen, or null for its first by key. */
  readonly defaultBlueprint: string | null;
}

export interface NewApplication {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly typeKey: string;
  readonly blueprintKey: string;
  readonly description: string;
  readonly createdBy: string;
}

/** The current company's applications, in one transaction. Another company's are never found. */
export interface CatalogSession extends EventLog {
  /** The types a company can register now, in the order they're shown. */
  availableTypes(): Promise<StoredApplicationType[]>;
  availableType(key: string): Promise<StoredApplicationType | null>;
  list(status: ApplicationStatus): Promise<StoredApplication[]>;
  /** The IDs of the applications with these short names, by short name. */
  idsBySlug(slugs: readonly string[]): Promise<Map<string, string>>;
  /** One application, locked until the transaction ends when asked, so no one else changes it meanwhile. */
  find(id: string, options?: { readonly lock?: boolean }): Promise<StoredApplication | null>;
  /** Lets one registration or rename at a time choose a name in the current company. */
  lockNames(): Promise<void>;
  /** Whether another application has this name, ignoring case, and if so, its status. */
  statusOfName(name: string, exceptId: string | null): Promise<ApplicationStatus | null>;
  isSlugTaken(slug: string): Promise<boolean>;
  add(application: NewApplication): Promise<void>;
  update(id: string, changes: { readonly name: string; readonly description: string }): Promise<void>;
  setStatus(id: string, status: ApplicationStatus): Promise<void>;
}

export const CATALOG_STORE = Symbol('CATALOG_STORE');

export type CatalogStore = Transactional<CatalogSession>;
