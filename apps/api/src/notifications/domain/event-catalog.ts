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
  BuildSucceeded: 'An image is built, scanned and signed',
  BuildFailed: 'An image build fails',
  ReleaseStarted: 'A release or hotfix starts',
  ReleaseMerged: 'A release or hotfix merges into main',
  ReleasePublished: "A release's final image is published",
  EnvironmentCreated: 'An environment is created',
  EnvironmentArchived: 'An environment is archived',
  TargetConnected: 'A target connects, or reconnects after being lost',
  TargetLost: 'A target stops reporting',
  TargetRevoked: 'A target is disconnected',
  DeploymentRequested: 'A deployment is asked for, or waits for approval',
  DeploymentRejected: 'A production deployment is rejected',
  DeploymentSucceeded: 'A deployment finishes',
  DeploymentFailed: 'A deployment fails',
  DeploymentAborted: 'A deployment is aborted',
  EnvironmentSecretSet: "An environment's secret is set",
};

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
      case 'BuildSucceeded':
        return `The ${String(payload.kind)} image ${String(payload.tag)} is ready and signed.`;
      case 'BuildFailed':
        return `The ${String(payload.kind)} image ${String(payload.tag)} failed: ${String(payload.reason ?? 'unknown reason')}`;
      case 'ReleaseStarted':
        return `The ${String(payload.kind)} ${String(payload.version)} started.`;
      case 'ReleaseMerged':
        return `The ${String(payload.kind)} ${String(payload.version)} merged into main.`;
      case 'ReleasePublished':
        return `Version ${String(payload.version)} is published.`;
      case 'CompanyEditionChanged':
        return `The company moved to the ${editionName(payload.edition)} Edition.`;
      case 'EnvironmentCreated':
        return `The ${String(payload.kind)} environment ${String(payload.name)} was created.`;
      case 'EnvironmentArchived':
        return `The environment ${String(payload.name)} was archived.`;
      case 'TargetConnected':
        return payload.reconnected === true
          ? `The target of ${String(payload.environmentName)} is reporting again.`
          : `A target connected to ${String(payload.environmentName)}.`;
      case 'TargetLost':
        return `The target of ${String(payload.environmentName)} stopped reporting.`;
      case 'TargetRevoked':
        return `The target of ${String(payload.environmentName)} was disconnected.`;
      case 'DeploymentRequested':
        return payload.needsApproval === true
          ? `A deployment to ${String(payload.environmentName)} waits for approval.`
          : `A deployment to ${String(payload.environmentName)} started.`;
      case 'DeploymentRejected':
        return `A deployment to ${String(payload.environmentName)} was rejected.`;
      case 'DeploymentSucceeded':
        return `${String(payload.applicationName)} ${String(payload.version)} runs in ${String(payload.environmentName)}.`;
      case 'DeploymentFailed':
        return `Deploying ${String(payload.applicationName)} ${String(payload.version)} to ${String(payload.environmentName)} failed.`;
      case 'DeploymentAborted':
        return `Deploying ${String(payload.applicationName)} ${String(payload.version)} to ${String(payload.environmentName)} was aborted.`;
      case 'EnvironmentSecretSet':
        return `The secret ${String(payload.name)} was set in ${String(payload.environmentName)}.`;
      default:
        return `${event.eventType} happened.`;
    }
  };
  return `${companyName}: ${describe()}`;
}
