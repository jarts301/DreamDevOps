import type { DynamicModule, Provider, Type } from '@nestjs/common';
import type { AppConfig } from '../config/app-config.ts';

/** What each module is given when the application is put together. */
export interface ModuleSettings {
  readonly config: AppConfig;
  /**
   * Replacements for providers, such as fakes in tests. Each module takes the ones for
   * tokens it provides itself.
   */
  readonly overrides: readonly Provider[];
}

/** The token a provider is registered under. */
export function tokenOf(provider: Provider): unknown {
  return typeof provider === 'function' ? provider : provider.provide;
}

/**
 * A module's providers, with any the settings replace swapped in. When several replace
 * the same token, the last one wins, as it would if they were all registered in order.
 */
export function withOverrides(providers: readonly Provider[], overrides: readonly Provider[]): Provider[] {
  return providers.map(
    (provider) => overrides.findLast((override) => tokenOf(override) === tokenOf(provider)) ?? provider,
  );
}

const registered = new WeakMap<ModuleSettings, Map<Type<unknown>, DynamicModule>>();

/**
 * Builds a module's definition once per application. Several modules may import the same
 * one, and Nest tells modules apart by reference, so each import must get the very same
 * definition, or Nest would create the module, and its routes, twice.
 */
export function registerOnce(settings: ModuleSettings, module: Type<unknown>, build: () => DynamicModule): DynamicModule {
  let modules = registered.get(settings);
  if (modules === undefined) {
    modules = new Map();
    registered.set(settings, modules);
  }
  let definition = modules.get(module);
  if (definition === undefined) {
    definition = build();
    modules.set(module, definition);
  }
  return definition;
}
