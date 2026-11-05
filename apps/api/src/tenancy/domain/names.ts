import { TenancyError } from './errors.ts';

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MIN_SLUG_LENGTH = 2;
export const MAX_SLUG_LENGTH = 40;
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
// Control characters would let a name break the layout of logs and screens.
const CONTROL_CHARACTERS = /\p{Cc}/u;

/**
 * Names Git hosting keeps for its own pages. A company slug becomes its Git
 * organization's name, so these would fail to provision.
 */
const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'assets',
  'attachments',
  'avatar',
  'avatars',
  'captcha',
  'commits',
  'debug',
  'error',
  'explore',
  'ghost',
  'help',
  'install',
  'issues',
  'login',
  'metrics',
  'milestones',
  'new',
  'notifications',
  'org',
  'pulls',
  'raw',
  'repo',
  'search',
  'stars',
  'template',
  'user',
  'v2',
]);

/** A name shown to people. Surrounding spaces are dropped. */
export function parseName(value: unknown, subject: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name === '' || name.length > MAX_NAME_LENGTH || CONTROL_CHARACTERS.test(name)) {
    throw new TenancyError('invalid', `Enter a ${subject} name of up to ${MAX_NAME_LENGTH} characters.`);
  }
  return name;
}

export function parseDescription(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  const description = typeof value === 'string' ? value.trim() : null;
  if (description === null || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new TenancyError('invalid', `Enter a description of up to ${MAX_DESCRIPTION_LENGTH} characters.`);
  }
  return description.replace(/\r\n/g, '\n');
}

/**
 * A slug names something in URLs and other tools, so it uses only lowercase letters,
 * digits and single hyphens between them.
 */
export function parseSlug(value: unknown): string {
  const slug = typeof value === 'string' ? value.trim() : '';
  if (slug.length < MIN_SLUG_LENGTH || slug.length > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(slug)) {
    throw new TenancyError(
      'invalid',
      `A slug has ${MIN_SLUG_LENGTH} to ${MAX_SLUG_LENGTH} lowercase letters and digits, with single hyphens between them.`,
    );
  }
  return slug;
}

export function parseCompanySlug(value: unknown): string {
  const slug = parseSlug(value);
  if (RESERVED_SLUGS.has(slug)) {
    throw new TenancyError('invalid', `The slug "${slug}" is reserved. Choose another.`);
  }
  return slug;
}

/** Suggests a slug from a name, such as "Acme Café" to "acme-cafe". */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
}

/** Uses the slug the caller chose, or one from the name when they didn't choose one. */
export function slugOrFromName(slugValue: unknown, name: string, parse: (value: unknown) => string): string {
  if (slugValue !== undefined && slugValue !== null && slugValue !== '') {
    return parse(slugValue);
  }
  // A suggested slug always has the right characters and length limit, but can be too short.
  const suggested = slugFromName(name);
  if (suggested.length < MIN_SLUG_LENGTH) {
    throw new TenancyError('invalid', 'This name has too few letters or digits to make a slug. Choose a slug.');
  }
  return parse(suggested);
}
