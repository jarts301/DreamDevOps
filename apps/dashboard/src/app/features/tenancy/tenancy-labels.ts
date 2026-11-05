import type { CompanyStatus, ResourceStatus } from './tenancy.api';

const COMPANY_STATUSES: Readonly<Record<CompanyStatus, string>> = {
  provisioning: 'Provisioning',
  active: 'Active',
  suspended: 'Suspended',
  closed: 'Closed',
  erased: 'Erased',
};

const RESOURCE_STATUSES: Readonly<Record<ResourceStatus, string>> = {
  pending: 'Pending',
  ready: 'Ready',
  failed: 'Failed',
  erased: 'Erased',
};

const RESOURCE_KINDS: Readonly<Record<string, string>> = {
  'git-organization': 'Git organization',
};

export function companyStatusLabel(status: CompanyStatus): string {
  return COMPANY_STATUSES[status] ?? status;
}

export function resourceStatusLabel(status: ResourceStatus): string {
  return RESOURCE_STATUSES[status] ?? status;
}

export function resourceKindLabel(kind: string): string {
  return RESOURCE_KINDS[kind] ?? kind;
}
