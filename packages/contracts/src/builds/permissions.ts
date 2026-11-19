import type { PermissionGrant } from '../permission.ts';

/** The permissions Builds checks: building test images from feature branches. */
export const BUILDS_PERMISSIONS: readonly PermissionGrant[] = [
  { permission: 'feature-images:build', roles: ['tech-lead', 'developer'] },
];
