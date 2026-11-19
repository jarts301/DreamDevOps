import type { PermissionGrant } from '../permission.ts';

/** The permissions Releases checks: starting and finishing releases. */
export const RELEASES_PERMISSIONS: readonly PermissionGrant[] = [
  { permission: 'releases:start', roles: ['tech-lead'] },
];
