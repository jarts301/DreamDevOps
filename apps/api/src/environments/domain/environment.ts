import { numberedSlug, slugFromName } from '../../shared/slug.ts';
import { EnvironmentError } from './errors.ts';

export type EnvironmentKind = 'test' | 'production';
export type EnvironmentStatus = 'active' | 'archived';

/** Short enough to name Kubernetes namespaces with the application's short name added. */
export const MAX_SLUG_LENGTH = 40;

/** Names are trimmed, single-spaced and between 2 and 40 characters, without control characters. */
export function normalizeEnvironmentName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  // eslint-disable-next-line no-control-regex
  if (name.length < 2 || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new EnvironmentError('invalid', 'Enter an environment name between 2 and 40 characters.');
  }
  return name;
}

export function parseKind(value: unknown): EnvironmentKind {
  if (value !== 'test' && value !== 'production') {
    throw new EnvironmentError('invalid', 'Choose test or production.');
  }
  return value;
}

/**
 * Production takes final images only. A test environment takes feature images unless
 * the company keeps unreviewed code off it, such as the one used to test RC images.
 */
export function acceptsFeatureImages(kind: EnvironmentKind, value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new EnvironmentError('invalid', 'Say whether the environment accepts feature images.');
  }
  if (kind === 'production') {
    if (value === true) {
      throw new EnvironmentError('invalid', 'Production accepts final images only.');
    }
    return false;
  }
  return value ?? true;
}

export function environmentSlug(name: string, number = 1): string {
  const base = slugFromName(name, { maxLength: MAX_SLUG_LENGTH, prefix: 'env' });
  return number === 1 ? base : numberedSlug(base, number, MAX_SLUG_LENGTH);
}

/** Which kinds of image an environment takes, for deployments to check. */
export function acceptedImageKinds(environment: {
  readonly kind: EnvironmentKind;
  readonly acceptsFeatureImages: boolean;
}): ('feature' | 'rc' | 'final')[] {
  if (environment.kind === 'production') {
    return ['final'];
  }
  return environment.acceptsFeatureImages ? ['feature', 'rc', 'final'] : ['rc', 'final'];
}
