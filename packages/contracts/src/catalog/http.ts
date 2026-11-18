/** The application catalog's HTTP API, as the dashboard and other contexts see it. Types only. */

export type ApplicationStatus = 'active' | 'archived';

/** A blueprint an application can start from: a language and a framework, such as TypeScript and React. */
export interface BlueprintChoice {
  readonly key: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly language: string;
  readonly framework: string;
}

/** A type of application a company can register now, such as a web frontend. */
export interface ApplicationType {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** The blueprint new applications of this type start from unless another is chosen. */
  readonly blueprint: BlueprintChoice;
  /** Every blueprint new applications of this type can start from, by language and name. */
  readonly blueprints: readonly BlueprintChoice[];
}

export interface ApplicationView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly type: { readonly key: string; readonly name: string };
  /** The blueprint it started from, chosen when it was registered. */
  readonly blueprint: { readonly key: string; readonly name: string; readonly language: string; readonly framework: string } | null;
  readonly description: string;
  readonly status: ApplicationStatus;
  readonly createdAt: string;
  readonly createdBy: { readonly userId: string; readonly displayName: string | null } | null;
  readonly archivedAt: string | null;
}

/** Registers an application of a type. */
export interface RegisterApplication {
  readonly name: string;
  /** An application type's key. */
  readonly type: string;
  /** The blueprint to start from. The type's default when left out. */
  readonly blueprint?: string;
  readonly description?: string;
}

/** Renames an application or changes its description. Fields left out stay as they are. */
export interface UpdateApplication {
  readonly name?: string;
  readonly description?: string;
}
