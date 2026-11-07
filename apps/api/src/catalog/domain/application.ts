import { numberedSlug, slugFromName } from '../../shared/slug.ts';
import { CatalogError } from './errors.ts';

export type ApplicationStatus = 'active' | 'archived';

/** Repository names allow more, but a short limit keeps them readable. */
export const MAX_SLUG_LENGTH = 60;
const MAX_DESCRIPTION_LENGTH = 500;

/** Names are trimmed, single-spaced and between 2 and 80 characters, without control characters. */
export function normalizeApplicationName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  // eslint-disable-next-line no-control-regex
  if (name.length < 2 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new CatalogError('invalid', 'Enter an application name between 2 and 80 characters.');
  }
  return name;
}

/** Descriptions are optional, trimmed, and at most 500 characters. Line breaks are kept. */
export function normalizeDescription(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  const description = typeof value === 'string' ? value.trim().replace(/\r\n?/g, '\n') : null;
  // eslint-disable-next-line no-control-regex
  if (description === null || description.length > MAX_DESCRIPTION_LENGTH || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(description)) {
    throw new CatalogError('invalid', 'Enter a description of at most 500 characters.');
  }
  return description;
}

export function applicationSlug(name: string, number = 1): string {
  const base = slugFromName(name, { maxLength: MAX_SLUG_LENGTH, prefix: 'app' });
  return number === 1 ? base : numberedSlug(base, number, MAX_SLUG_LENGTH);
}
