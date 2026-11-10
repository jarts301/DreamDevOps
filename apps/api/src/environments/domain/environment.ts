import { normalizeName } from '../../shared/names.ts';
import { numberedSlug, slugFromName } from '../../shared/slug.ts';
import { EnvironmentError } from './errors.ts';

export type RecordStatus = 'active' | 'archived';

/** Short names name an environment's infrastructure, such as billing-api-staging, so they stay short. */
export const MAX_ENVIRONMENT_SLUG_LENGTH = 30;

/** Names are trimmed, single-spaced and between 2 and 40 characters, without control characters. */
export function normalizeEnvironmentName(value: unknown): string {
  const name = normalizeName(value, { minLength: 2, maxLength: 40, refuseControlCharacters: true });
  if (name === null) {
    throw new EnvironmentError('invalid', 'Enter an environment name between 2 and 40 characters.');
  }
  return name;
}

export function normalizeTargetName(value: unknown): string {
  const name = normalizeName(value, { minLength: 2, maxLength: 80, refuseControlCharacters: true });
  if (name === null) {
    throw new EnvironmentError('invalid', 'Enter a target name between 2 and 80 characters.');
  }
  return name;
}

export function environmentSlug(name: string, number = 1): string {
  const base = slugFromName(name, { maxLength: MAX_ENVIRONMENT_SLUG_LENGTH, prefix: 'env' });
  return number === 1 ? base : numberedSlug(base, number, MAX_ENVIRONMENT_SLUG_LENGTH);
}

/**
 * The version a change was based on. Every change must say it, so nobody overwrites a
 * change they haven't seen.
 */
export function parseVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new EnvironmentError('invalid', 'Say which version of this you changed.');
  }
  return value;
}

export function assertCurrentVersion(expected: number, current: number): void {
  if (expected !== current) {
    throw new EnvironmentError('conflict', 'Someone else changed this meanwhile. Reload it and try again.');
  }
}
