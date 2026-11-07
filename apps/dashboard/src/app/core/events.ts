import { roleName } from './labels';

const EDITION_NAMES: Readonly<Record<string, string>> = { community: 'Community', commercial: 'Commercial' };

function editionName(edition: unknown): string {
  return typeof edition === 'string' ? (EDITION_NAMES[edition] ?? edition) : 'unknown';
}

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
    case 'ApplicationRegistered':
      return `Registered the application "${String(payload['name'])}"`;
    case 'ApplicationUpdated':
      return payload['name'] === undefined
        ? "Changed an application's description"
        : `Renamed the application "${String(payload['previousName'])}" to "${String(payload['name'])}"`;
    case 'ApplicationArchived':
      return `Archived the application "${String(payload['name'])}"`;
    case 'ApplicationRestored':
      return `Restored the application "${String(payload['name'])}"`;
    case 'CompanyEditionChanged':
      return `Moved the company from the ${editionName(payload['previousEdition'])} to the ${editionName(payload['edition'])} Edition`;
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
