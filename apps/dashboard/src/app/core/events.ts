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
    case 'RepositoryRequested':
      return "Asked for an application's repository to be created";
    case 'RepositoryCreated':
      return `Created the repository ${String(payload['repository'])} for "${String(payload['name'])}"`;
    case 'RepositoryCreationFailed':
      return `Creating the repository of "${String(payload['name'])}" failed: ${String(payload['reason'] ?? 'unknown reason')}`;
    case 'CodePushed':
      return `Pushed ${String(payload['commits'] ?? 0)} commits to ${String(payload['branch'])}`;
    case 'BranchCreated':
      return `Created the branch ${String(payload['branch'])}`;
    case 'BranchDeleted':
      return `Deleted the branch ${String(payload['branch'])}`;
    case 'PullRequestUpdated':
      return `Updated pull request #${String(payload['number'])} from ${String(payload['head'])} into ${String(payload['base'])}`;
    case 'PullRequestMerged':
      return `Merged pull request #${String(payload['number'])} from ${String(payload['head'])} into ${String(payload['base'])}`;
    case 'BuildRequested':
      return `Asked for the image ${String(payload['tag'])}`;
    case 'BuildSucceeded':
      return `Built, scanned and signed the image ${String(payload['tag'])}`;
    case 'BuildFailed':
      return `The image ${String(payload['tag'])} failed: ${String(payload['reason'] ?? 'unknown reason')}`;
    case 'FeatureImageDeleted':
      return `Deleted the feature image ${String(payload['tag'])}`;
    case 'ReleaseStarted':
      return `Started the ${String(payload['kind'])} ${String(payload['version'])}`;
    case 'ReleaseCandidateCreated':
      return `Tagged release candidate ${String(payload['tag'])}`;
    case 'ReleaseMerged':
      return `Merged the ${String(payload['kind'])} ${String(payload['version'])} into main`;
    case 'ReleasePublished':
      return `Published version ${String(payload['version'])}`;
    case 'EnvironmentCreated':
      return `Created the ${payload['kind'] === 'production' ? 'production' : 'test'} environment "${String(payload['name'])}"`;
    case 'EnvironmentUpdated':
      if (payload['name'] !== undefined) {
        return `Renamed the environment "${String(payload['previousName'])}" to "${String(payload['name'])}"`;
      }
      return payload['acceptsFeatureImages'] === true
        ? 'Let an environment accept feature images'
        : 'Stopped an environment from accepting feature images';
    case 'EnvironmentArchived':
      return `Archived the environment "${String(payload['name'])}"`;
    case 'EnvironmentRestored':
      return `Restored the environment "${String(payload['name'])}"`;
    case 'TargetRegistrationStarted':
      return `Created a command to connect a target to "${String(payload['environmentName'])}"`;
    case 'TargetConnected':
      return payload['reconnected'] === true
        ? `The target of "${String(payload['environmentName'])}" is reporting again`
        : `Connected a target to "${String(payload['environmentName'])}", key ${String(payload['keyFingerprint'])}`;
    case 'TargetLost':
      return `The target of "${String(payload['environmentName'])}" stopped reporting`;
    case 'TargetRevoked':
      return payload['wasConnected'] === true
        ? `Disconnected the target of "${String(payload['environmentName'])}"`
        : `Cancelled connecting a target to "${String(payload['environmentName'])}"`;
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
