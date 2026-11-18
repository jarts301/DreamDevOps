import { roleName as contractRoleName } from '@dreamdevops/contracts/identity-access/roles';

const PERMISSION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'companies:manage': 'Start new companies',
  'audit:read-own': 'Read your own audit history',
  'editions:manage': "Set each company's edition",
  'company-users:manage': 'Manage company users and roles',
  'targets:connect': 'Connect hosting targets, where environments run',
  'environments:manage': 'Manage environments',
  'environments-production:manage': 'Change production environments, with their name typed and a reason',
  'environment-config:manage': "Manage every environment's variables and secrets",
  'test-environment-config:manage': "Manage test environments' variables and secrets",
  'applications:create': 'Register and manage applications',
  'code:push': 'Push code and open pull requests',
  'pull-requests:approve': 'Approve pull requests',
  'releases:start': 'Start releases and hotfixes',
  'feature-images:build': 'Build feature test images',
  'deployments-test:run': 'Deploy to test and roll back',
  'deployments-production:run': 'Deploy to production and roll back',
  'dashboards:view': 'View dashboards and logs',
  'audit:read': 'Read the audit log',
  'notifications:manage': 'Manage chat notifications',
  'alerts:manage': 'Manage alerts on metrics, and whom they email',
};

/** A role's name, such as "Tech Lead", as Identity and access's contracts name it. */
export function roleName(role: string | null): string {
  return role === null ? 'No role' : contractRoleName(role);
}

export function permissionDescription(permission: string): string {
  return PERMISSION_DESCRIPTIONS[permission] ?? permission;
}
