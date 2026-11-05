const ROLE_NAMES: Readonly<Record<string, string>> = {
  'company-admin': 'Company Admin',
  'tech-lead': 'Tech Lead',
  developer: 'Developer',
  operator: 'Operator',
  viewer: 'Viewer',
};

const PERMISSION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'companies:manage': 'Create and manage companies',
  'audit:read-own': 'Read your own audit history',
  'company-users:manage': 'Manage company users and roles',
  'targets:connect': 'Connect deployment targets',
  'applications:view': 'See applications',
  'applications:create': 'Create applications',
  'applications:update': 'Change application names and descriptions',
  'applications:archive': 'Archive and restore applications',
  'applications:configure': 'Change application settings and secrets',
  'applications:migrate': 'Run application database migrations',
  'applications:run': 'Start, stop and restart applications',
  'applications:test': 'Run application tests',
  'applications:monitor': 'Monitor application health, metrics and logs',
  'code:push': 'Push code and open pull requests',
  'pull-requests:approve': 'Approve pull requests',
  'releases:start': 'Start releases and hotfixes',
  'feature-images:build': 'Build feature test images',
  'deployments-test:run': 'Deploy to test and roll back',
  'deployments-production:run': 'Deploy to production and roll back',
  'dashboards:view': 'View dashboards and logs',
  'audit:read': 'Read the audit log',
};

export function roleName(role: string | null): string {
  return role === null ? 'No role' : (ROLE_NAMES[role] ?? role);
}

export function permissionDescription(permission: string): string {
  return PERMISSION_DESCRIPTIONS[permission] ?? permission;
}

/** A company's name, or a shortened ID while the name isn't known. */
export function companyLabel(company: { readonly companyId: string; readonly companyName?: string | null }): string {
  return company.companyName || `Company ${company.companyId.slice(0, 8)}`;
}
