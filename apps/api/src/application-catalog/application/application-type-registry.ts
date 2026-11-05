import type { ApplicationTypes } from '../../tenancy/application/ports.ts';
import type { ApplicationType } from '../domain/application-type.ts';
import type { Scaffold } from '../domain/scaffold.ts';
import { InvalidApplicationTypeError, validateApplicationType } from '../domain/validation.ts';

/** The application types DreamDevOps supports. It refuses a catalog that breaks any rule. */
export class ApplicationTypeRegistry implements ApplicationTypes {
  readonly #types: ReadonlyMap<string, ApplicationType>;
  readonly #scaffolds: ReadonlyMap<string, { readonly scaffold: Scaffold; readonly type: ApplicationType }>;

  constructor(catalog: readonly ApplicationType[]) {
    const types = new Map<string, ApplicationType>();
    const scaffolds = new Map<string, { scaffold: Scaffold; type: ApplicationType }>();
    for (const type of catalog) {
      validateApplicationType(type);
      if (types.has(type.key)) {
        throw new InvalidApplicationTypeError(type.key, 'is defined twice.');
      }
      types.set(type.key, type);
      // Applications store a scaffold's key on its own, so it names one scaffold in the whole catalog.
      for (const scaffold of type.scaffolds) {
        if (scaffolds.has(scaffold.key)) {
          throw new InvalidApplicationTypeError(type.key, `has the scaffold "${scaffold.key}", which another type has too.`);
        }
        scaffolds.set(scaffold.key, { scaffold, type });
      }
    }
    this.#scaffolds = scaffolds;
    // Frontends first, then backends, and by language within each.
    const ordered = [...types.values()].sort(
      (a, b) => a.layer.order - b.layer.order || a.language.name.localeCompare(b.language.name) || a.name.localeCompare(b.name),
    );
    this.#types = new Map(ordered.map((type) => [type.key, type]));
  }

  list(): readonly ApplicationType[] {
    return [...this.#types.values()];
  }

  get(key: string): ApplicationType | undefined {
    return this.#types.get(key);
  }

  has(key: string): boolean {
    return this.#types.has(key);
  }

  scaffoldsOf(key: string): readonly { readonly key: string; readonly name: string }[] {
    return this.#types.get(key)?.scaffolds.map(({ key: scaffoldKey, name }) => ({ key: scaffoldKey, name })) ?? [];
  }

  /** The scaffold, and the type it belongs to. */
  scaffold(key: string): { readonly scaffold: Scaffold; readonly type: ApplicationType } | undefined {
    return this.#scaffolds.get(key);
  }

  scaffoldKeys(): readonly string[] {
    return [...this.#scaffolds.keys()];
  }
}
