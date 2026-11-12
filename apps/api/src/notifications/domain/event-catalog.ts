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
  CompanyEditionChanged: "The company's edition changes",
  ApplicationRegistered: 'An application is registered',
  ApplicationUpdated: 'An application is renamed or its description changes',
  ApplicationArchived: 'An application is archived',
  ApplicationRestored: 'An archived application is restored',
  RepositoryCreated: "An application's repository is ready",
  RepositoryCreationFailed: "Creating an application's repository fails",
  ReleaseStarted: 'A release is started',
  HotfixStarted: 'A hotfix is started',
  BuildSucceeded: 'An image is built, signed and published',
  BuildFailed: 'Building an image fails',
  HostingTargetConnected: 'A hosting target is connected',
  HostingTargetUpdated: "A hosting target's settings change",
  EnvironmentCreated: 'An environment is created',
  EnvironmentTargetSwitched: 'An environment moves to another hosting target',
  EnvironmentProtected: 'An environment becomes production',
  EnvironmentUnprotected: 'An environment stops being production',
  EnvironmentArchived: 'An environment is archived',
  DeploymentQueued: 'A deployment is asked for',
  DeploymentSucceeded: 'A version is deployed, moved or stopped',
  DeploymentFailed: 'A deployment fails',
  EnvironmentVariableSet: "An environment's variable or secret is added or changed",
  EnvironmentVariableRemoved: "An environment's variable or secret is removed",
  AlertTriggered: 'An alert starts firing',
  AlertResolved: 'A firing alert is resolved',
};

const BUILD_KIND_NAMES: Readonly<Record<string, string>> = {
  development: 'development image',
  'release-candidate': 'release candidate',
  'hotfix-candidate': 'hotfix candidate',
  release: 'release',
};

export function buildKindName(kind: unknown): string {
  return typeof kind === 'string' ? (BUILD_KIND_NAMES[kind] ?? kind) : 'image';
}

const EDITION_NAMES: Readonly<Record<string, string>> = {
  community: 'Community',
  commercial: 'Commercial',
};

export function editionName(edition: unknown): string {
  return typeof edition === 'string' ? (EDITION_NAMES[edition] ?? edition) : 'an edition';
}

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

/** The reason someone gave for a change to production, for the end of a sentence. */
function because(reason: unknown): string {
  return typeof reason === 'string' && reason !== '' ? `: "${reason}"` : '';
}

/** What a deployment does, as a sentence without its end, such as 'Deploying 1.5.0 of "Billing" to "Production" failed'. */
function deploymentAction(payload: Record<string, unknown>, stage: 'requested' | 'done' | 'failed'): string {
  const version = typeof payload.version === 'string' ? payload.version : 'what runs';
  const where = `${payload.production ? 'production environment' : 'environment'} "${String(payload.environmentName)}" of "${String(payload.applicationName)}"`;
  const verbs: Readonly<Record<string, readonly [string, string, string]>> = {
    deploy: [`Deploying ${version} to the ${where} was requested`, `${version} was deployed to the ${where}`, `Deploying ${version} to the ${where} failed`],
    move: [
      `Moving ${version} of the ${where} to "${String(payload.targetName)}" was requested`,
      `${version} of the ${where} moved to "${String(payload.targetName)}"`,
      `Moving ${version} of the ${where} to "${String(payload.targetName)}" failed`,
    ],
    stop: [`Stopping ${version} in the ${where} was requested`, `${version} was stopped in the ${where}`, `Stopping ${version} in the ${where} failed`],
  };
  const [requested, done, failedText] = verbs[String(payload.kind)] ?? verbs.deploy!;
  return stage === 'requested' ? requested : stage === 'done' ? done : failedText;
}

/** Where an alert looks, such as 'the production environment "Production" of "Billing"'. */
function alertPlace(payload: Record<string, unknown>): string {
  return `the ${payload.production ? 'production ' : ''}environment "${String(payload.environmentName)}" of "${String(payload.applicationName)}"`;
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
      case 'ApplicationRegistered':
        return `The application "${String(payload.name)}" was registered.`;
      case 'ApplicationUpdated':
        return payload.name === undefined
          ? "An application's description changed."
          : `The application "${String(payload.previousName)}" was renamed to "${String(payload.name)}".`;
      case 'ApplicationArchived':
        return `The application "${String(payload.name)}" was archived.`;
      case 'ApplicationRestored':
        return `The application "${String(payload.name)}" was restored.`;
      case 'RepositoryCreated':
        return `The repository of "${String(payload.name)}" is ready: ${String(payload.repository)}.`;
      case 'RepositoryCreationFailed':
        return `Creating the repository of "${String(payload.name)}" failed.`;
      case 'ReleaseStarted':
        return `Release ${String(payload.version)} of "${String(payload.name)}" started on ${String(payload.branch)}.`;
      case 'HotfixStarted':
        return `Hotfix ${String(payload.version)} of "${String(payload.name)}" started on ${String(payload.branch)}.`;
      case 'BuildSucceeded':
        return payload.kind === 'release'
          ? `Version ${String(payload.version)} of "${String(payload.name)}" is released: ${String(payload.image)}.`
          : `The ${buildKindName(payload.kind)} ${String(payload.version)} of "${String(payload.name)}" is ready: ${String(payload.image)}.`;
      case 'BuildFailed':
        return `Building ${String(payload.version)} of "${String(payload.name)}" failed${payload.step ? ` at "${String(payload.step)}"` : ''}.`;
      case 'HostingTargetConnected':
        return `The hosting target "${String(payload.name)}" was connected.`;
      case 'HostingTargetUpdated':
        return `The hosting target "${String(payload.name)}" changed${payload.servesProduction ? ', and production runs on it' : ''}${because(payload.reason)}.`;
      case 'EnvironmentCreated':
        return `The ${payload.production ? 'production ' : ''}environment "${String(payload.name)}" of "${String(payload.applicationName)}" was created.`;
      case 'EnvironmentTargetSwitched':
        return `The ${payload.production ? 'production ' : ''}environment "${String(payload.name)}" of "${String(payload.applicationName)}" moved to another hosting target${because(payload.reason)}.`;
      case 'EnvironmentProtected':
        return `The environment "${String(payload.name)}" of "${String(payload.applicationName)}" is now production${because(payload.reason)}.`;
      case 'EnvironmentUnprotected':
        return `The environment "${String(payload.name)}" of "${String(payload.applicationName)}" is no longer production${because(payload.reason)}.`;
      case 'EnvironmentArchived':
        return `The environment "${String(payload.name)}" of "${String(payload.applicationName)}" was archived.`;
      case 'DeploymentQueued':
        return `${deploymentAction(payload, 'requested')}${because(payload.reason)}.`;
      case 'DeploymentSucceeded':
        return `${deploymentAction(payload, 'done')}${typeof payload.address === 'string' ? `: ${payload.address}` : ''}.`;
      case 'DeploymentFailed':
        return `${deploymentAction(payload, 'failed')}${payload.step ? ` at "${String(payload.step)}"` : ''}${
          typeof payload.stillRunning === 'string' ? `. ${payload.stillRunning} still runs` : ''
        }.`;
      case 'EnvironmentVariableSet':
      case 'EnvironmentVariableRemoved':
        return `The ${payload.secret ? 'secret' : 'variable'} ${String(payload.name)} of the ${payload.production ? 'production ' : ''}environment "${String(payload.environmentName)}" of "${String(payload.applicationName)}" was ${
          event.eventType === 'EnvironmentVariableRemoved' ? 'removed' : payload.change === 'added' ? 'added' : 'changed'
        }${because(payload.reason)}.`;
      case 'CompanyEditionChanged':
        return `The company moved to the ${editionName(payload.edition)} Edition.`;
      case 'AlertTriggered':
        return `The alert "${String(payload.name)}" is firing: ${alertPlace(payload)} has ${String(payload.condition)}, at ${String(payload.value)}.`;
      case 'AlertResolved':
        return `The alert "${String(payload.name)}" is resolved: ${alertPlace(payload)} no longer has ${String(payload.condition)}, at ${String(payload.value)}.`;
      default:
        return `${event.eventType} happened.`;
    }
  };
  return `${companyName}: ${describe()}`;
}
