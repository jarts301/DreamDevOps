import type { Edition } from '../domain/features.ts';

export const ENTITLEMENT_PROVIDER = Symbol('ENTITLEMENT_PROVIDER');

export interface ProviderStatus {
  /** Shown to platform admins, such as "Community". */
  readonly name: string;
  /** Whether commercial features are installed and licensed on this server. */
  readonly commercialAvailable: boolean;
  /** More detail for platform admins, such as when a license ends. */
  readonly detail: string | null;
}

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
