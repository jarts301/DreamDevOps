import type { PermissionGrant } from '../permission.ts';

/** The permissions the audit log checks: a company's history, and a platform admin's own activity. */
export const AUDIT_PERMISSIONS: readonly PermissionGrant[] = [
  { permission: 'audit:read', roles: ['company-admin'] },
  { permission: 'audit:read-own', roles: ['platform-admin'] },
];
