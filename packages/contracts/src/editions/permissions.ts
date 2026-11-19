import type { PermissionGrant } from '../permission.ts';

/** The permissions Editions checks: choosing each company's edition, for the platform. */
export const EDITIONS_PERMISSIONS: readonly PermissionGrant[] = [
  { permission: 'editions:manage', roles: ['platform-admin'] },
];
