import { EditionError } from './errors.ts';

export type Edition = 'community' | 'commercial';

export const EDITIONS: readonly Edition[] = ['community', 'commercial'];

export interface Feature {
  /** A stable key. Routes and screens refer to it, so it must never change. */
  readonly key: string;
  readonly name: string;
  readonly edition: Edition;
}

/**
 * Every feature the platform has or plans, and the edition that includes it.
 * Commercial features are built in separate, private code. Listing them here lets
 * the dashboard show what each edition offers, and lets routes refer to them.
 */
export const FEATURES: readonly Feature[] = [
  { key: 'companies-and-roles', name: 'Companies, members and roles', edition: 'community' },
  { key: 'audit-history', name: 'Tamper-evident audit history', edition: 'community' },
  { key: 'notifications', name: 'Email and chat notifications', edition: 'community' },
  { key: 'git-flow', name: 'Blueprints, repositories, branch rules and releases', edition: 'community' },
  { key: 'standard-deployments', name: 'Recreate, rolling and blue/green deployments, with rollback', edition: 'community' },
  { key: 'monitoring', name: 'Default dashboards, logs, traces and alerts', edition: 'community' },
  { key: 'custom-approval-policies', name: 'Custom approval policies', edition: 'commercial' },
  { key: 'progressive-deployments', name: 'Canary and A/B deployments, with automatic abort', edition: 'commercial' },
  { key: 'enterprise-sso', name: 'Enterprise single sign-on', edition: 'commercial' },
  { key: 'audit-export', name: 'Audit export', edition: 'commercial' },
  { key: 'extended-retention', name: 'Longer monitoring retention', edition: 'commercial' },
  { key: 'service-level-reports', name: 'Service-level reports', edition: 'commercial' },
];

const FEATURE_KEYS = new Set(FEATURES.map((feature) => feature.key));
const COMMUNITY_FEATURES = FEATURES.filter((feature) => feature.edition === 'community').map((feature) => feature.key);
const COMMERCIAL_FEATURES = new Set(
  FEATURES.filter((feature) => feature.edition === 'commercial').map((feature) => feature.key),
);

export function isFeatureKey(key: string): boolean {
  return FEATURE_KEYS.has(key);
}

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
