import type { EventLog, Transactional } from '@dreamdevops/shared-kernel';
import type { CompanyStatus } from '../domain/company.ts';

export const GIT_PROVIDER = Symbol('GIT_PROVIDER');

export interface GitOrganization {
  /** The organization's name in the Git tool, which is the company's slug. */
  readonly name: string;
  readonly displayName: string;
  readonly companyId: string;
}

/** The Git tool that holds each company's isolated group of repositories. */
export interface GitProvider {
  /**
   * Creates the organization, or brings an existing one up to date. Safe to repeat.
   * Returns the organization's ID in the Git tool.
   */
  ensureOrganization(organization: GitOrganization): Promise<string>;
}

/** Retrying can't help, such as when another owner already uses the name. */
export class PermanentProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentProvisioningError';
  }
}

/** A company as the register keeps it. */
export interface StoredCompany {
  readonly name: string;
  readonly slug: string;
  readonly status: CompanyStatus;
}

/** A company as platform admins list it, with why setting it up failed, while it has. */
export interface ListedCompany extends StoredCompany {
  readonly id: string;
  readonly createdAt: Date;
  readonly provisioningError: string | null;
}

/** A resource a company needs, such as its Git organization, as setting it up leaves it. */
export interface ResourceStep {
  readonly status: 'ready' | 'failed';
  readonly externalId: string | null;
  readonly error: string | null;
}

/**
 * The company register and each company's resources, in one transaction. The register is
 * platform data, so listing it needs no company's context; everything else runs in the
 * company's own.
 */
export interface TenancySession extends EventLog {
  listCompanies(): Promise<ListedCompany[]>;
  /** A company, locked until the transaction ends, so its status is read and changed safely. */
  lockCompany(companyId: string): Promise<StoredCompany | null>;
  /** Whether another company has this name, ignoring case. */
  isNameTaken(name: string, exceptId: string | null): Promise<boolean>;
  isSlugTaken(slug: string): Promise<boolean>;
  /** Adds a company, being set up, and returns when it was created. */
  addCompany(company: { readonly id: string; readonly name: string; readonly slug: string; readonly createdBy: string }): Promise<Date>;
  rename(companyId: string, name: string): Promise<void>;
  suspend(companyId: string): Promise<void>;
  /** Ends a suspension, and sets the company up again. */
  reactivate(companyId: string): Promise<void>;
  setStatus(companyId: string, status: CompanyStatus): Promise<void>;
  /** Lets every resource of the company be set up again, from its first attempt. */
  resetResources(companyId: string): Promise<void>;
  /** Claims a resource for this job for a while, unless another job's claim still holds. */
  claimResource(companyId: string, kind: string, seconds: number): Promise<boolean>;
  renewClaim(companyId: string, kind: string, seconds: number): Promise<void>;
  /** Records how setting up a resource went, releases its claim, and returns its failed attempts in a row. */
  recordStep(companyId: string, kind: string, step: ResourceStep): Promise<number>;
}

export const TENANCY_STORE = Symbol('TENANCY_STORE');

export type TenancyStore = Transactional<TenancySession>;
