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
