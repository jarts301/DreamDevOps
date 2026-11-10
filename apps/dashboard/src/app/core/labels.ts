const ROLE_NAMES: Readonly<Record<string, string>> = {
  'company-admin': 'Company Admin',
  'tech-lead': 'Tech Lead',
  developer: 'Developer',
  operator: 'Operator',
  viewer: 'Viewer',
};

const PERMISSION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'companies:manage': 'Start new companies',
  'audit:read-own': 'Read your own audit history',
  'editions:manage': "Set each company's edition",
  'company-users:manage': 'Manage company users and roles',
  'targets:connect': 'Connect hosting targets, where environments run',
  'environments:manage': 'Manage environments',
  'environments-production:manage': 'Change production environments, with their name typed and a reason',
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
};

export function roleName(role: string | null): string {
  return role === null ? 'No role' : (ROLE_NAMES[role] ?? role);
}

export function permissionDescription(permission: string): string {
  return PERMISSION_DESCRIPTIONS[permission] ?? permission;
}
