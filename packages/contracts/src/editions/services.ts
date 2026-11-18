/** What Editions answers for other contexts. */

export const FEATURE_ACCESS = Symbol('FEATURE_ACCESS');

/** Whether a company's edition includes a feature, such as progressive-deployments. */
export interface FeatureAccess {
  isEnabled(companyId: string, featureKey: string): Promise<boolean>;
}
