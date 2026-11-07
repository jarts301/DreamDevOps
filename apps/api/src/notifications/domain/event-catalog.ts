import type { DomainEvent } from '@dreamdevops/shared-kernel';

/** The company events people can be notified about, with a description of each. */
export const NOTIFIABLE_EVENTS: Readonly<Record<string, string>> = {
  UserInvited: 'Someone is invited to the company',
  RoleGranted: "Someone joins or a member's role changes",
  MemberRemoved: 'A member is removed',
  InvitationRevoked: 'An invitation is revoked',
  CompanyRenamed: 'The company is renamed',
  CompanySuspended: 'The company is suspended',
  CompanyReactivated: 'The company is reactivated',
  CompanyProvisioned: 'The company finishes setting up',
  CompanyProvisioningFailed: 'Setting up the company fails',
};

const ROLE_NAMES: Readonly<Record<string, string>> = {
  'company-admin': 'Company Admin',
  'tech-lead': 'Tech Lead',
  developer: 'Developer',
  operator: 'Operator',
  viewer: 'Viewer',
};

export function roleName(role: unknown): string {
  return typeof role === 'string' ? (ROLE_NAMES[role] ?? role) : 'a role';
}

/** A one-line message about an event. Payloads hold IDs, not names or emails. */
export function summarize(event: DomainEvent, companyName: string): string {
  const payload = event.payload as Record<string, unknown>;
  const describe = (): string => {
    switch (event.eventType) {
      case 'UserInvited':
        return `Someone was invited as ${roleName(payload.role)}.`;
      case 'RoleGranted':
        return payload.invitationId === undefined
          ? `A member's role changed to ${roleName(payload.role)}.`
          : `Someone joined as ${roleName(payload.role)}.`;
      case 'MemberRemoved':
        return 'A member was removed.';
      case 'InvitationRevoked':
        return 'An invitation was revoked.';
      case 'CompanyRenamed':
        return `The company was renamed from "${String(payload.previousName)}".`;
      case 'CompanySuspended':
        return 'The company was suspended.';
      case 'CompanyReactivated':
        return 'The company was reactivated.';
      case 'CompanyProvisioned':
        return 'The company finished setting up.';
      case 'CompanyProvisioningFailed':
        return 'Setting up the company failed.';
      default:
        return `${event.eventType} happened.`;
    }
  };
  return `${companyName}: ${describe()}`;
}
