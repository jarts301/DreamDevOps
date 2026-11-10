import { normalizeName } from '../../shared/names.ts';
import { numberedSlug as sharedNumberedSlug, slugFromName as sharedSlugFromName } from '../../shared/slug.ts';
import { TenancyError } from './errors.ts';

export type CompanyStatus = 'provisioning' | 'active' | 'provisioning-failed' | 'suspended';

export interface Company {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: CompanyStatus;
  readonly createdAt: string;
}

const MAX_SLUG_LENGTH = 40;

/** Names are trimmed, single-spaced and between 2 and 80 characters, without control characters. */
export function normalizeCompanyName(value: unknown): string {
  const name = normalizeName(value, { minLength: 2, maxLength: 80, refuseControlCharacters: true });
  if (name === null) {
    throw new TenancyError('invalid', 'Enter a company name between 2 and 80 characters.');
  }
  return name;
}

/** A short, fixed identifier made from the name, used for the company's resources. */
export function slugFromName(name: string): string {
  return sharedSlugFromName(name, { maxLength: MAX_SLUG_LENGTH, prefix: 'company' });
}

/** Adds a numbered suffix when the slug is taken, keeping it within the length limit. */
export function numberedSlug(slug: string, number: number): string {
  return sharedNumberedSlug(slug, number, MAX_SLUG_LENGTH);
}
