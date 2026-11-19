import type { PermissionGrant } from '../permission.ts';

/** The permissions Environments checks: environments, their targets, and their variables and secrets. */
export const ENVIRONMENTS_PERMISSIONS: readonly PermissionGrant[] = [
  { permission: 'targets:connect', roles: ['company-admin', 'operator'] },
  { permission: 'environments-production:manage', roles: ['tech-lead', 'operator'] },
  { permission: 'environment-config:manage', roles: ['tech-lead', 'operator'] },
  { permission: 'test-environment-config:manage', roles: ['company-admin', 'tech-lead', 'operator'] },
];
