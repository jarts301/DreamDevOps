import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/** A kind of application, as the Application Catalog describes it. */
export interface ApplicationType {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly layer: { readonly key: string; readonly name: string; readonly description: string };
  readonly language: {
    readonly key: string;
    readonly name: string;
    readonly runtime: { readonly name: string; readonly version: string; readonly image: string };
  };
  readonly frameworks: readonly string[];
  readonly serving:
    | { readonly kind: 'static'; readonly directory: string }
    | { readonly kind: 'process'; readonly port: number; readonly healthCheckPath: string };
  readonly commands: Readonly<Record<string, string>>;
  readonly scaffolds: readonly Scaffold[];
}

/** A project an application can start from, which follows its type's commands. */
export interface Scaffold {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly includes: readonly string[];
}

/** The choice of no scaffold. Scaffold keys have no colons, so it can't be one. */
export const EMPTY_REPOSITORY = ':empty';

export interface ApplicationTypeGroup {
  readonly layer: ApplicationType['layer'];
  readonly types: readonly ApplicationType[];
}

/** The order commands run in, for showing them. Commands a future type adds come last. */
const COMMAND_ORDER = ['install', 'lint', 'test', 'build', 'migrate', 'start'];

export function orderedCommands(type: ApplicationType): { readonly name: string; readonly command: string }[] {
  const rank = (name: string) => (COMMAND_ORDER.includes(name) ? COMMAND_ORDER.indexOf(name) : COMMAND_ORDER.length);
  return Object.entries(type.commands)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([name, command]) => ({ name, command }));
}

/** Groups types by layer, keeping the catalog's order, so a new layer needs no change here. */
export function groupByLayer(types: readonly ApplicationType[]): ApplicationTypeGroup[] {
  const groups = new Map<string, ApplicationTypeGroup>();
  for (const type of types) {
    const group = groups.get(type.layer.key) ?? { layer: type.layer, types: [] };
    groups.set(type.layer.key, { ...group, types: [...group.types, type] });
  }
  return [...groups.values()];
}

@Injectable({ providedIn: 'root' })
export class ApplicationCatalogApi {
  readonly #http = inject(HttpClient);
  #types: Promise<ApplicationType[]> | undefined;

  /** The catalog only changes with a new version of DreamDevOps, so it's asked for once. */
  types(): Promise<ApplicationType[]> {
    this.#types ??= firstValueFrom(this.#http.get<ApplicationType[]>('/api/v1/application-types')).catch(
      (error: unknown) => {
        this.#types = undefined;
        throw error;
      },
    );
    return this.#types;
  }
}
