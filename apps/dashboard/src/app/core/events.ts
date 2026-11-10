import { roleName } from './labels';

const EDITION_NAMES: Readonly<Record<string, string>> = { community: 'Community', commercial: 'Commercial' };

function editionName(edition: unknown): string {
  return typeof edition === 'string' ? (EDITION_NAMES[edition] ?? edition) : 'unknown';
}

/** The reason given for a change to production, at the end of a description. */
function because(reason: unknown): string {
  return typeof reason === 'string' && reason !== '' ? `, because "${reason}"` : '';
}

/** Where a deployment went, such as 'the production environment "Production" of "Billing"'. */
function deploymentPlace(payload: Readonly<Record<string, unknown>>): string {
  return `the ${payload['production'] ? 'production ' : ''}environment "${String(payload['environmentName'])}" of "${String(payload['applicationName'])}"`;
}

function deployedVersion(payload: Readonly<Record<string, unknown>>): string {
  return typeof payload['version'] === 'string' ? payload['version'] : 'what ran';
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
    case 'ReleaseStarted':
      return `Started release ${String(payload['version'])} of "${String(payload['name'])}" on ${String(payload['branch'])}`;
    case 'HotfixStarted':
      return `Started hotfix ${String(payload['version'])} of "${String(payload['name'])}" on ${String(payload['branch'])}`;
    case 'BuildQueued':
      return payload['retry'] === true
        ? `Asked to build ${String(payload['version'])} of "${String(payload['name'])}" again`
        : `Asked to build ${String(payload['version'])} of "${String(payload['name'])}" from ${String(payload['branch'])}`;
    case 'BuildSucceeded':
      return payload['kind'] === 'release'
        ? `Released version ${String(payload['version'])} of "${String(payload['name'])}" as ${String(payload['image'])}`
        : `Built, signed and published ${String(payload['version'])} of "${String(payload['name'])}"`;
    case 'BuildFailed':
      return `Building ${String(payload['version'])} of "${String(payload['name'])}" failed${payload['step'] ? ` at "${String(payload['step'])}"` : ''}: ${String(payload['reason'] ?? 'unknown reason')}`;
    case 'HostingTargetConnected':
      return `Connected the hosting target "${String(payload['name'])}"`;
    case 'HostingTargetUpdated':
      return `Changed the hosting target "${String(payload['name'])}"${payload['servesProduction'] ? ', which production runs on' : ''}${because(payload['reason'])}`;
    case 'HostingTargetArchived':
      return `Archived the hosting target "${String(payload['name'])}"`;
    case 'HostingTargetRestored':
      return `Restored the hosting target "${String(payload['name'])}"`;
    case 'EnvironmentCreated':
      return `Created the ${payload['production'] ? 'production ' : ''}environment "${String(payload['name'])}" of "${String(payload['applicationName'])}"`;
    case 'EnvironmentRenamed':
      return `Renamed the environment "${String(payload['previousName'])}" of "${String(payload['applicationName'])}" to "${String(payload['name'])}"${because(payload['reason'])}`;
    case 'EnvironmentTargetSwitched':
      return `Moved the environment "${String(payload['name'])}" of "${String(payload['applicationName'])}" to another hosting target${because(payload['reason'])}`;
    case 'EnvironmentProtected':
      return `Made the environment "${String(payload['name'])}" of "${String(payload['applicationName'])}" production${because(payload['reason'])}`;
    case 'EnvironmentUnprotected':
      return `Removed production protection from the environment "${String(payload['name'])}" of "${String(payload['applicationName'])}"${because(payload['reason'])}`;
    case 'EnvironmentArchived':
      return `Archived the environment "${String(payload['name'])}" of "${String(payload['applicationName'])}"`;
    case 'EnvironmentRestored':
      return `Restored the environment "${String(payload['name'])}" of "${String(payload['applicationName'])}"`;
    case 'DeploymentQueued':
      switch (payload['kind']) {
        case 'move':
          return `Asked to move ${deployedVersion(payload)} of ${deploymentPlace(payload)} to "${String(payload['targetName'])}"${because(payload['reason'])}`;
        case 'stop':
          return `Asked to stop ${deployedVersion(payload)} in ${deploymentPlace(payload)}${because(payload['reason'])}`;
        default:
          return `Asked to deploy ${deployedVersion(payload)} to ${deploymentPlace(payload)}${because(payload['reason'])}`;
      }
    case 'DeploymentSucceeded':
      switch (payload['kind']) {
        case 'move':
          return `Moved ${deployedVersion(payload)} of ${deploymentPlace(payload)} to "${String(payload['targetName'])}"`;
        case 'stop':
          return `Stopped ${deployedVersion(payload)} in ${deploymentPlace(payload)}`;
        default:
          return `Deployed ${deployedVersion(payload)} to ${deploymentPlace(payload)}${typeof payload['address'] === 'string' ? `, at ${payload['address']}` : ''}`;
      }
    case 'DeploymentFailed':
      return `${payload['kind'] === 'stop' ? 'Stopping' : payload['kind'] === 'move' ? 'Moving' : 'Deploying'} ${deployedVersion(payload)} ${payload['kind'] === 'stop' ? 'in' : payload['kind'] === 'move' ? 'of' : 'to'} ${deploymentPlace(payload)} failed${payload['step'] ? ` at "${String(payload['step'])}"` : ''}: ${String(payload['error'] ?? 'unknown reason').replace(/\.$/, '')}${typeof payload['stillRunning'] === 'string' ? `. ${payload['stillRunning']} still runs` : ''}`;
    case 'EnvironmentVariableSet':
    case 'EnvironmentVariableRemoved': {
      const verb =
        eventType === 'EnvironmentVariableRemoved' ? 'Removed' : payload['change'] === 'added' ? 'Added' : 'Changed';
      return `${verb} the ${payload['secret'] ? 'secret' : 'variable'} ${String(payload['name'])} of ${deploymentPlace(payload)}${because(payload['reason'])}`;
    }
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
