import type { PermissionGrant } from '../permission.ts';

/** The permissions Alerts checks: the alerts that watch what runs. */
export const ALERTS_PERMISSIONS: readonly PermissionGrant[] = [
  { permission: 'alerts:manage', roles: ['company-admin', 'tech-lead', 'operator'] },
];
