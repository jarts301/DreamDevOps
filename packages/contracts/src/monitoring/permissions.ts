import type { PermissionGrant } from '../permission.ts';

/** The permissions Monitoring checks: seeing what runs, and how it does. */
export const MONITORING_PERMISSIONS: readonly PermissionGrant[] = [
  { permission: 'dashboards:view', roles: ['company-admin', 'tech-lead', 'developer', 'operator', 'viewer'] },
];
