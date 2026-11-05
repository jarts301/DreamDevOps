import { Controller, Get, Inject } from '@nestjs/common';
import { Authenticated } from '../../http/access.decorators.ts';
import { ApplicationTypeRegistry } from '../application/application-type-registry.ts';
import type { ApplicationType } from '../domain/application-type.ts';

/** What the dashboard shows of a type. Everything in it is the same for every company. */
export interface ApplicationTypeView {
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
  readonly serving: ApplicationType['serving'];
  readonly commands: ApplicationType['commands'];
  readonly scaffolds: readonly {
    readonly key: string;
    readonly name: string;
    readonly description: string;
    readonly includes: readonly string[];
  }[];
}

/** The catalog holds no company data, so anyone signed in may read it. */
@Controller('application-types')
export class ApplicationTypesController {
  readonly #registry: ApplicationTypeRegistry;

  constructor(@Inject(ApplicationTypeRegistry) registry: ApplicationTypeRegistry) {
    this.#registry = registry;
  }

  @Authenticated()
  @Get()
  list(): ApplicationTypeView[] {
    return this.#registry.list().map((type) => ({
      key: type.key,
      name: type.name,
      description: type.description,
      layer: { key: type.layer.key, name: type.layer.name, description: type.layer.description },
      language: { key: type.language.key, name: type.language.name, runtime: type.language.runtime },
      frameworks: type.frameworks,
      serving: type.serving,
      commands: type.commands,
      scaffolds: type.scaffolds.map(({ key, name, description, includes }) => ({ key, name, description, includes })),
    }));
  }
}
