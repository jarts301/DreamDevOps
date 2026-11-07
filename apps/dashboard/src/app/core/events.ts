import { roleName } from './labels';

/** Describes a recorded event for people. Payloads hold IDs and roles, not names or emails. */
export function describeEvent(eventType: string, payload: Readonly<Record<string, unknown>>): string {
  const role = typeof payload['role'] === 'string' ? roleName(payload['role']) : 'a role';
  switch (eventType) {
    case 'CompanyCreated':
      return `Created the company "${String(payload['name'])}"`;
    case 'CompanyRenamed':
      return `Renamed the company from "${String(payload['previousName'])}" to "${String(payload['name'])}"`;
    case 'CompanySuspended':
      return 'Suspended the company';
    case 'CompanyReactivated':
      return 'Reactivated the company';
    case 'CompanyProvisioningRequested':
      return 'Asked for the company to be set up';
    case 'CompanyProvisioned':
      return 'Finished setting up the company';
    case 'CompanyProvisioningFailed':
      return `Setting up the company failed: ${String(payload['reason'] ?? 'unknown reason')}`;
    case 'UserInvited':
      return `Invited someone as ${role}`;
    case 'RoleGranted':
      return payload['invitationId'] === undefined ? `Changed a member's role to ${role}` : `Joined as ${role}`;
    case 'MemberRemoved':
      return `Removed a member who was ${role}`;
    case 'InvitationRevoked':
      return 'Revoked an invitation';
    default:
      return eventType;
  }
}
