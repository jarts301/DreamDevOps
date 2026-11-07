import type { EntitlementProvider, ProviderStatus } from '../application/ports.ts';

/** The free default: every Community feature is on, and there are no commercial features to turn on. */
export class CommunityEntitlementProvider implements EntitlementProvider {
  async status(): Promise<ProviderStatus> {
    return { name: 'Community', commercialAvailable: false, detail: null };
  }

  async commercialFeatures(): Promise<ReadonlySet<string>> {
    return new Set();
  }
}
