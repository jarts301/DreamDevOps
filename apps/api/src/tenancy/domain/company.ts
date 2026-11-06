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
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  // eslint-disable-next-line no-control-regex
  if (name.length < 2 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new TenancyError('invalid', 'Enter a company name between 2 and 80 characters.');
  }
  return name;
}

/**
 * A short, fixed identifier made from the name, used for the company's resources.
 * It keeps only letters, digits and single hyphens, so it suits most tools' naming rules.
 */
export function slugFromName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug.length >= 2 ? slug : `company-${slug}`.replace(/-+$/, '') || 'company';
}

/** Adds a numbered suffix when the slug is taken, keeping it within the length limit. */
export function numberedSlug(slug: string, number: number): string {
  const suffix = `-${number}`;
  return `${slug.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
}
