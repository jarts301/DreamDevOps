import { ALERTS_PERMISSIONS } from './alerts/permissions.ts';
import { AUDIT_PERMISSIONS } from './audit/permissions.ts';
import { BUILDS_PERMISSIONS } from './builds/permissions.ts';
import { CATALOG_PERMISSIONS } from './catalog/permissions.ts';
import { DEPLOYMENTS_PERMISSIONS } from './deployments/permissions.ts';
import { EDITIONS_PERMISSIONS } from './editions/permissions.ts';
import { ENVIRONMENTS_PERMISSIONS } from './environments/permissions.ts';
import { IDENTITY_ACCESS_PERMISSIONS } from './identity-access/permissions.ts';
import { MONITORING_PERMISSIONS } from './monitoring/permissions.ts';
import { NOTIFICATIONS_PERMISSIONS } from './notifications/permissions.ts';
import { RELEASES_PERMISSIONS } from './releases/permissions.ts';
import { SOURCE_GOVERNANCE_PERMISSIONS } from './source-governance/permissions.ts';
import { TENANCY_PERMISSIONS } from './tenancy/permissions.ts';
import type { PermissionGrant } from './permission.ts';

export type { PermissionGrant } from './permission.ts';

/**
 * Every permission the contexts check, each declared by the context that checks it, with the
 * roles that have it by default. Identity and access adds those missing when it starts.
 */
export const ALL_PERMISSIONS: readonly PermissionGrant[] = [
  ...IDENTITY_ACCESS_PERMISSIONS,
  ...TENANCY_PERMISSIONS,
  ...AUDIT_PERMISSIONS,
  ...NOTIFICATIONS_PERMISSIONS,
  ...EDITIONS_PERMISSIONS,
  ...CATALOG_PERMISSIONS,
  ...SOURCE_GOVERNANCE_PERMISSIONS,
  ...BUILDS_PERMISSIONS,
  ...RELEASES_PERMISSIONS,
  ...ENVIRONMENTS_PERMISSIONS,
  ...DEPLOYMENTS_PERMISSIONS,
  ...MONITORING_PERMISSIONS,
  ...ALERTS_PERMISSIONS,
];
