import type { PermissionGrant } from '../permission.ts';

/** The permissions the Application Catalog checks: registering and changing applications. */
export const CATALOG_PERMISSIONS: readonly PermissionGrant[] = [
  { permission: 'applications:create', roles: ['company-admin', 'tech-lead'] },
];
