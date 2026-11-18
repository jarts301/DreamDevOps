import type { EventLog, Transactional } from '@dreamdevops/shared-kernel';
import type { EditionProviderStatus } from '@dreamdevops/contracts/editions/http';
import type { Edition } from '../domain/features.ts';

export const ENTITLEMENT_PROVIDER = Symbol('ENTITLEMENT_PROVIDER');

/** What the provider says of itself, which platform admins see. */
export type ProviderStatus = EditionProviderStatus;

/**
 * The extension point for the Commercial Edition. This repository includes only the
 * Community provider. The commercial code supplies its own, which checks its license
 * and turns on the commercial features it has installed.
 */
export interface EntitlementProvider {
  status(): Promise<ProviderStatus>;
  /** The commercial features turned on for a company on the Commercial Edition. */
  commercialFeatures(company: { readonly companyId: string; readonly edition: Edition }): Promise<ReadonlySet<string>>;
}

/** A company's chosen edition. Companies without one are on the Community Edition. */
export interface ChosenEdition {
  readonly companyId: string;
  readonly edition: Edition;
  readonly changedAt: Date;
}

/** Each company's edition, in one transaction. */
export interface EditionsSession extends EventLog {
  /** The company's edition, or the Community Edition when it was never changed. */
  editionOf(companyId: string): Promise<Edition>;
  /** Lets one change of the company's edition happen at a time, so the previous edition is always right. */
  lockCompany(companyId: string): Promise<void>;
  setEdition(companyId: string, edition: Edition, changedBy: string): Promise<void>;
  /** Every edition chosen, in any company, for platform admins. */
  chosen(): Promise<ChosenEdition[]>;
}

export const EDITIONS_STORE = Symbol('EDITIONS_STORE');

export type EditionsStore = Transactional<EditionsSession>;
