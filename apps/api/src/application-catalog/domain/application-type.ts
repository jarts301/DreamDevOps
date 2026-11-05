import type { Scaffold } from './scaffold.ts';

/** How a language installs, checks, builds and runs code. Every type in the language shares it. */
export interface Language {
  /** Such as "typescript". Part of each type's key. */
  readonly key: string;
  readonly name: string;
  readonly runtime: {
    readonly name: string;
    readonly version: string;
    /** The container image applications of this language build on. */
    readonly image: string;
  };
  /** The commands an application's repository must support, run from its root. */
  readonly commands: {
    readonly install: string;
    readonly lint: string;
    readonly test: string;
    /** Languages that compile or bundle. */
    readonly build?: string;
    readonly start: string;
    readonly migrate: string;
  };
  /** Where a running application listens, unless its type says otherwise. */
  readonly defaultPort: number;
}

/** What an application does for the company, such as a frontend or a backend. */
export interface Layer {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** Where the layer appears in lists. */
  readonly order: number;
  /** Whether applications of the layer may own a database, and so run migrations. */
  readonly migrations: boolean;
}

/** How an application reaches people once it's built. */
export type Serving =
  /** Built files that any web server can hand out. */
  | { readonly kind: 'static'; readonly directory: string }
  /** A process that keeps running and answers on a port. */
  | { readonly kind: 'process'; readonly port: number; readonly healthCheckPath: string };

export interface ApplicationTypeCommands {
  readonly install: string;
  readonly lint: string;
  readonly test: string;
  readonly build?: string;
  /** Only for applications served by a process. */
  readonly start?: string;
  /** Only for layers that may own a database. */
  readonly migrate?: string;
}

/** A kind of application DreamDevOps can build, test and run, such as a TypeScript frontend. */
export interface ApplicationType {
  /** Stored with each application, so it never changes once published. */
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly layer: Layer;
  readonly language: Language;
  /** Frameworks that follow the type's conventions. Any other that does works too. */
  readonly frameworks: readonly string[];
  readonly serving: Serving;
  readonly commands: ApplicationTypeCommands;
  /** Projects an application of this type can start from. Each follows the type's commands. */
  readonly scaffolds: readonly Scaffold[];
}

export interface ApplicationTypeDefinition {
  readonly language: Language;
  readonly layer: Layer;
  readonly description: string;
  readonly frameworks: readonly string[];
  /** A process listens on its language's default port unless this sets one. */
  readonly serving:
    | Extract<Serving, { kind: 'static' }>
    | { readonly kind: 'process'; readonly port?: number; readonly healthCheckPath: string };
  /** Defaults to "<language>-<layer>". Set it when a language has more than one type in a layer. */
  readonly key?: string;
  /** Defaults to "<Language> <layer>", such as "TypeScript frontend". */
  readonly name?: string;
  /** Replaces the language's commands for this type only. */
  readonly commands?: Partial<ApplicationTypeCommands>;
  readonly scaffolds?: readonly Scaffold[];
}

/**
 * Makes a type from its language and layer, so a definition only says what is special
 * about it. It takes the language's commands that apply: a start command only for a
 * process, and migrations only for a layer that may own a database.
 */
export function defineApplicationType(definition: ApplicationTypeDefinition): ApplicationType {
  const { language, layer } = definition;
  const serving: Serving =
    definition.serving.kind === 'process'
      ? {
          kind: 'process',
          port: definition.serving.port ?? language.defaultPort,
          healthCheckPath: definition.serving.healthCheckPath,
        }
      : definition.serving;
  const { install, lint, test, build, start, migrate } = language.commands;

  return {
    key: definition.key ?? `${language.key}-${layer.key}`,
    name: definition.name ?? `${language.name} ${layer.name.toLowerCase()}`,
    description: definition.description,
    layer,
    language,
    frameworks: definition.frameworks,
    serving,
    commands: {
      install,
      lint,
      test,
      ...(build !== undefined && { build }),
      ...(serving.kind === 'process' && { start }),
      ...(layer.migrations && { migrate }),
      ...definition.commands,
    },
    scaffolds: definition.scaffolds ?? [],
  };
}
