import type { PermissionGrant } from '../permission.ts';

/** The permissions Tenancy checks: starting and running companies, for the platform. */
export const TENANCY_PERMISSIONS: readonly PermissionGrant[] = [
  { permission: 'companies:manage', roles: ['platform-admin'] },
];
