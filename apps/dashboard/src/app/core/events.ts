import { roleName } from './labels';

const EDITION_NAMES: Readonly<Record<string, string>> = { community: 'Community', commercial: 'Commercial' };

function editionName(edition: unknown): string {
  return typeof edition === 'string' ? (EDITION_NAMES[edition] ?? edition) : 'unknown';
}

/** The reason given for a change to production, at the end of a description. */
function because(reason: unknown): string {
  return typeof reason === 'string' && reason !== '' ? `, because "${reason}"` : '';
}

/** Where an alert watches, such as 'Billing API in the production environment "Live"'. */
function alertPlace(payload: Readonly<Record<string, unknown>>): string {
  return `${String(payload['applicationName'])} in the ${payload['production'] ? 'production ' : ''}environment "${String(payload['environmentName'])}"`;
}

const ALERT_CHANGES: Readonly<Record<string, string>> = {
  name: 'its name',
  threshold: 'its threshold',
  forMinutes: 'how long it waits',
  recipients: 'whom it emails',
};

/** What changed about an alert, such as ": its threshold and whom it emails", or that it was turned on or off. */
function alertChanges(payload: Readonly<Record<string, unknown>>): string {
  const changes = Array.isArray(payload['changes']) ? (payload['changes'] as unknown[]) : [];
  const parts = changes.flatMap((change) => (typeof change === 'string' && ALERT_CHANGES[change] ? [ALERT_CHANGES[change]] : []));
  const switched = changes.includes('enabled') ? (payload['enabled'] ? ', and turned it on' : ', and turned it off') : '';
  if (parts.length === 0) {
    return switched.replace(', and', ':');
  }
  const listed = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `: ${listed}${switched}`;
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
        return `Renamed the environment "${String(payload['previousName'])}" to "${String(payload['name'])}"${because(payload['reason'])}`;
      }
      return payload['acceptsFeatureImages'] === true
        ? 'Let an environment accept feature images'
        : 'Stopped an environment from accepting feature images';
    case 'EnvironmentArchived':
      return `Archived the environment "${String(payload['name'])}"${because(payload['reason'])}`;
    case 'EnvironmentRestored':
      return `Restored the environment "${String(payload['name'])}"`;
    case 'TargetRegistrationStarted':
      return `Created a command to connect a target to "${String(payload['environmentName'])}"`;
    case 'TargetConnected':
      if (payload['provider'] === 'local') {
        return `Set "${String(payload['environmentName'])}" to run on this machine`;
      }
      return payload['reconnected'] === true
        ? `The target of "${String(payload['environmentName'])}" is reporting again`
        : `Connected a target to "${String(payload['environmentName'])}", key ${String(payload['keyFingerprint'])}`;
    case 'TargetLost':
      return `The target of "${String(payload['environmentName'])}" stopped reporting`;
    case 'TargetRevoked':
      return payload['wasConnected'] === true
        ? `Disconnected the target of "${String(payload['environmentName'])}"${because(payload['reason'])}`
        : `Cancelled connecting a target to "${String(payload['environmentName'])}"`;
    case 'EnvironmentVariableSet':
      return `Set the variable ${String(payload['name'])} in "${String(payload['environmentName'])}"${payload['applicationId'] ? ' for one application' : ''}${because(payload['reason'])}`;
    case 'EnvironmentVariableRemoved':
      return `Removed the variable ${String(payload['name'])} from "${String(payload['environmentName'])}"${because(payload['reason'])}`;
    case 'EnvironmentSecretSet':
      return `Set the secret ${String(payload['name'])} in "${String(payload['environmentName'])}"${payload['applicationId'] ? ' for one application' : ''}${because(payload['reason'])}`;
    case 'EnvironmentSecretRemoved':
      return `Removed the secret ${String(payload['name'])} from "${String(payload['environmentName'])}"${because(payload['reason'])}`;
    case 'DeploymentRequested':
      if (payload['action'] === 'stop') {
        return `Asked to stop an application in "${String(payload['environmentName'])}"${because(payload['reason'])}`;
      }
      if (payload['action'] === 'apply') {
        return `Asked to apply the values of "${String(payload['environmentName'])}" to what runs there${because(payload['reason'])}`;
      }
      return payload['rollbackOf']
        ? `Asked to roll back in "${String(payload['environmentName'])}"`
        : `Asked for a ${String(payload['strategy'])} deployment to "${String(payload['environmentName'])}"${payload['needsApproval'] ? ', which needs approval' : ''}`;
    case 'DeploymentApproved':
      return `Approved a deployment to "${String(payload['environmentName'])}"`;
    case 'DeploymentRejected':
      return `Rejected a deployment to "${String(payload['environmentName'])}"`;
    case 'DeploymentQueued':
      return 'Queued a deployment';
    case 'DeploymentStarted':
      return `Committed a deployment to "${String(payload['environmentName'])}"`;
    case 'DeploymentPromoted':
      return `Switched traffic to the new version in "${String(payload['environmentName'])}"`;
    case 'DeploymentAbortRequested':
      return `Asked to abort a deployment to "${String(payload['environmentName'])}"`;
    case 'DeploymentSucceeded':
      if (payload['action'] === 'stop') {
        return `Stopped ${String(payload['applicationName'])} in "${String(payload['environmentName'])}"`;
      }
      return `Deployed ${String(payload['applicationName'])} ${String(payload['version'])} to "${String(payload['environmentName'])}"`;
    case 'DeploymentFailed':
      return `Deploying ${String(payload['applicationName'])} ${String(payload['version'])} to "${String(payload['environmentName'])}" failed: ${String(payload['reason'] ?? 'unknown reason')}`;
    case 'DeploymentAborted':
      return `Aborted deploying ${String(payload['applicationName'])} ${String(payload['version'])} to "${String(payload['environmentName'])}"`;
    case 'AlertCreated':
      return `Created the alert "${String(payload['name'])}" on ${String(payload['condition'])} for ${alertPlace(payload)}`;
    case 'AlertUpdated':
      return `Changed the alert "${String(payload['name'])}" for ${alertPlace(payload)}${alertChanges(payload)}`;
    case 'AlertDeleted':
      return `Deleted the alert "${String(payload['name'])}" for ${alertPlace(payload)}`;
    case 'AlertTriggered':
      return `The alert "${String(payload['name'])}" fired: ${String(payload['condition'])} for ${alertPlace(payload)}, at ${String(payload['value'])}`;
    case 'AlertResolved':
      return `The alert "${String(payload['name'])}" was resolved: ${String(payload['condition'])} no longer holds for ${alertPlace(payload)}, at ${String(payload['value'])}`;
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
