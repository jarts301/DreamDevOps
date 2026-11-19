import type { PermissionGrant } from '../permission.ts';

/** The permissions Identity and access checks: managing a company's members. */
export const IDENTITY_ACCESS_PERMISSIONS: readonly PermissionGrant[] = [
  { permission: 'company-users:manage', roles: ['company-admin'] },
];
