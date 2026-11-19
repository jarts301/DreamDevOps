import type { PermissionGrant } from '../permission.ts';

/** The permissions Source governance gives in each company's Git service: pushing code and approving pull requests. */
export const SOURCE_GOVERNANCE_PERMISSIONS: readonly PermissionGrant[] = [
  { permission: 'code:push', roles: ['tech-lead', 'developer'] },
  { permission: 'pull-requests:approve', roles: ['tech-lead'] },
];
