import type { CompanyStatus } from './http.ts';

/** What Tenancy answers for other contexts. */

export type { CompanyStatus } from './http.ts';

/** What other contexts may know about a company. */
export interface CompanyRecord {
  readonly id: string;
  readonly name: string;
  /** Fixed at creation. It names the company's resources, such as its Git organization. */
  readonly slug: string;
  readonly status: CompanyStatus;
}

export const COMPANY_DIRECTORY = Symbol('COMPANY_DIRECTORY');

/**
 * Tenancy's published read model. Other contexts ask here about companies instead of
 * reading Tenancy's tables, so Tenancy can later move to its own service and database
 * without breaking them.
 */
export interface CompanyDirectory {
  find(companyId: string): Promise<CompanyRecord | null>;
  findBySlug(slug: string): Promise<CompanyRecord | null>;
  /** Every company, by name. */
  all(): Promise<CompanyRecord[]>;
}
