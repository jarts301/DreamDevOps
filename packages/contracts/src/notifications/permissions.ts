import type { PermissionGrant } from '../permission.ts';

/** The permissions Notifications checks: the rules that post events to chat tools. */
export const NOTIFICATIONS_PERMISSIONS: readonly PermissionGrant[] = [
  { permission: 'notifications:manage', roles: ['company-admin'] },
];
