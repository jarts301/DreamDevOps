import type { PermissionGrant } from '../permission.ts';

/** The permissions Deployments checks: deploying to test and production environments. */
export const DEPLOYMENTS_PERMISSIONS: readonly PermissionGrant[] = [
  { permission: 'deployments-test:run', roles: ['tech-lead', 'developer', 'operator'] },
  { permission: 'deployments-production:run', roles: ['tech-lead', 'operator'] },
];
