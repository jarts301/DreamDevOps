import { EnvironmentError } from './errors.ts';

/** Names as shells and most languages accept them: a letter or underscore, then letters, digits and underscores. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The platform sets these itself, so people can't. */
export const PLATFORM_PREFIX = 'DREAMDEVOPS_';
/** PORT is the blueprint's, and the others belong to the container. */
const RESERVED = new Set(['PORT', 'PATH', 'HOSTNAME']);

/**
 * Limits that keep the values an application starts with within what a container's start
 * can carry. They apply to each scope: the environment's shared values, and each
 * application's own.
 */
export const MAX_VALUES = 100;
export const MAX_VALUE_BYTES = 32 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024;

/**
 * Checks a variable's or secret's name. Names are case-sensitive, as in every container,
 * but two names that differ only in case aren't allowed in one scope, so nobody confuses them.
 */
export function parseVariableName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!NAME.test(name)) {
    throw new EnvironmentError(
      'invalid',
      'Use a name of letters, digits and underscores that starts with a letter or underscore, such as DATABASE_URL.',
    );
  }
  if (name.toUpperCase().startsWith(PLATFORM_PREFIX) || RESERVED.has(name.toUpperCase())) {
    throw new EnvironmentError('invalid', `${name} is set by the platform or the container, so it can't be set here.`);
  }
  return name;
}

/**
 * Checks a value, which is kept exactly as given: spaces count. Values fit on one line,
 * because that's what every container runtime passes on safely. Encode multi-line values,
 * such as keys, in base64.
 */
export function parseVariableValue(value: unknown, options: { readonly secret: boolean }): string {
  if (typeof value !== 'string') {
    throw new EnvironmentError('invalid', 'Enter a value.');
  }
  if (options.secret && value === '') {
    throw new EnvironmentError('invalid', 'Enter the secret’s value.');
  }
  if (/[\r\n]/.test(value)) {
    throw new EnvironmentError('invalid', 'Values must fit on one line. Encode multi-line values, such as keys, in base64.');
  }
  // Text that doesn't survive UTF-8, such as a lone surrogate, comes back changed.
  if (value.includes('\u0000') || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new EnvironmentError('invalid', 'The value holds characters a container can’t be given.');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw new EnvironmentError('invalid', `Keep each value under ${MAX_VALUE_BYTES / 1024} KB.`);
  }
  return value;
}

/** Refuses a change that would make one scope's values too many or too large, by each value's size in bytes. */
export function assertWithinLimits(sizes: readonly number[]): void {
  if (sizes.length > MAX_VALUES) {
    throw new EnvironmentError('conflict', `Each environment, and each application in it, can have up to ${MAX_VALUES} variables and secrets.`);
  }
  if (sizes.reduce((sum, size) => sum + size, 0) > MAX_TOTAL_BYTES) {
    throw new EnvironmentError('conflict', `Each environment's values, and each application's own, can total up to ${MAX_TOTAL_BYTES / 1024} KB.`);
  }
}

/** What the platform tells every application about where it runs. */
export function platformVariables(
  environment: { readonly slug: string; readonly production: boolean },
  version: string,
): Record<string, string> {
  return {
    DREAMDEVOPS_ENVIRONMENT: environment.slug,
    DREAMDEVOPS_PRODUCTION: String(environment.production),
    DREAMDEVOPS_VERSION: version,
  };
}
