import { TenancyError } from './errors.ts';

/**
 * provisioning → active        once every required resource is ready
 * active       → suspended     members lose access, and nothing is deleted
 * suspended    → active        members get access back
 * any but closed → closed      permanent; the slug stays reserved
 * closed       → erased        permanent; everything that identifies the company is replaced
 */
export type CompanyStatus = 'provisioning' | 'active' | 'suspended' | 'closed' | 'erased';

export type CompanyAction = 'suspend' | 'reactivate' | 'close' | 'erase';

export type ApplicationStatus = 'active' | 'archived';

export type ApplicationAction = 'archive' | 'restore';

/** What each company needs in other tools before its members can use it. */
export const REQUIRED_RESOURCES = ['git-organization'] as const;
export type ResourceKind = (typeof REQUIRED_RESOURCES)[number];
export type ResourceStatus = 'pending' | 'ready' | 'failed' | 'erased';

const COMPANY_TRANSITIONS: Readonly<Record<CompanyAction, { from: readonly CompanyStatus[]; to: CompanyStatus }>> = {
  suspend: { from: ['active'], to: 'suspended' },
  reactivate: { from: ['suspended'], to: 'active' },
  close: { from: ['provisioning', 'active', 'suspended'], to: 'closed' },
  erase: { from: ['closed'], to: 'erased' },
};

const COMPANY_REFUSALS: Readonly<Record<CompanyAction, string>> = {
  suspend: 'Only an active company can be suspended.',
  reactivate: 'Only a suspended company can be reactivated.',
  close: 'This company is already closed.',
  erase: 'Close the company before erasing its data.',
};

const ERASED = "This company's data has been erased, so it can't change.";

/** The status a company moves to, or an explanation of why it can't. */
export function nextCompanyStatus(current: CompanyStatus, action: CompanyAction): CompanyStatus {
  const transition = COMPANY_TRANSITIONS[action];
  if (!transition.from.includes(current)) {
    throw new TenancyError('conflict', current === 'erased' ? ERASED : COMPANY_REFUSALS[action]);
  }
  return transition.to;
}

export function nextApplicationStatus(current: ApplicationStatus, action: ApplicationAction): ApplicationStatus {
  if (action === 'archive') {
    if (current !== 'active') {
      throw new TenancyError('conflict', 'This application is already archived.');
    }
    return 'archived';
  }
  if (current !== 'archived') {
    throw new TenancyError('conflict', 'This application is not archived.');
  }
  return 'active';
}
