import { type Edition, FEATURES } from '@dreamdevops/contracts/editions/features';
import { EditionError } from './errors.ts';

// The editions and their features are Editions' published language, kept in its contracts.
export { EDITIONS, type Edition, type Feature, FEATURES, isFeatureKey } from '@dreamdevops/contracts/editions/features';

const COMMUNITY_FEATURES = FEATURES.filter((feature) => feature.edition === 'community').map((feature) => feature.key);
const COMMERCIAL_FEATURES = new Set(
  FEATURES.filter((feature) => feature.edition === 'commercial').map((feature) => feature.key),
);

export function parseEdition(value: unknown): Edition {
  if (value === 'community' || value === 'commercial') {
    return value;
  }
  throw new EditionError('invalid', 'Choose the Community or Commercial edition.');
}

/**
 * Works out which features a company has. Community features are always on, so no
 * provider can take them away. Commercial features come only from the provider, and
 * only for a company on the Commercial Edition, so a faulty provider can't hand them
 * to a Community company.
 */
export function resolveFeatures(edition: Edition, fromProvider: ReadonlySet<string>): ReadonlySet<string> {
  const enabled = new Set(COMMUNITY_FEATURES);
  if (edition === 'commercial') {
    for (const key of fromProvider) {
      if (COMMERCIAL_FEATURES.has(key)) {
        enabled.add(key);
      }
    }
  }
  return enabled;
}
