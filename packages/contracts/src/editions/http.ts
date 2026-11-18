import type { Edition } from './features.ts';

/** Editions' HTTP API, as the dashboard sees it. Types only, so a browser app can use them. */

export type { Edition } from './features.ts';

export interface FeatureView {
  readonly key: string;
  readonly name: string;
  readonly edition: Edition;
  /** Whether the company has it now. */
  readonly enabled: boolean;
}

/** What the current company's edition includes. */
export interface CompanyEntitlements {
  readonly edition: Edition;
  readonly features: readonly FeatureView[];
}

export interface CompanyEditionView {
  readonly companyId: string;
  readonly companyName: string;
  readonly edition: Edition;
  /** When a platform admin last set it. Null while it's the Community Edition every company starts on. */
  readonly changedAt: string | null;
}

/** Whether the Commercial Edition is installed on this server, as platform admins see it. */
export interface EditionProviderStatus {
  /** Such as "Community". */
  readonly name: string;
  /** Whether commercial features are installed and licensed on this server. */
  readonly commercialAvailable: boolean;
  /** More detail for platform admins, such as when a license ends. */
  readonly detail: string | null;
}

/** Every company's edition, for platform admins. It reveals no company data. */
export interface EditionsOverview {
  readonly provider: EditionProviderStatus;
  readonly companies: readonly CompanyEditionView[];
}
