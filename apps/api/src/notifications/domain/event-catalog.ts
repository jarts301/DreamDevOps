import { AlertResolved, AlertTriggered } from '@dreamdevops/contracts/alerts/events';
import { BuildFailed, BuildSucceeded } from '@dreamdevops/contracts/builds/events';
import { ApplicationArchived, ApplicationRegistered, ApplicationRestored, ApplicationUpdated } from '@dreamdevops/contracts/catalog/events';
import {
  DeploymentAborted,
  DeploymentFailed,
  DeploymentRejected,
  DeploymentRequested,
  DeploymentSucceeded,
} from '@dreamdevops/contracts/deployments/events';
import { CompanyEditionChanged } from '@dreamdevops/contracts/editions/events';
import {
  EnvironmentArchived,
  EnvironmentCreated,
  EnvironmentSecretSet,
  TargetConnected,
  TargetLost,
  TargetRevoked,
} from '@dreamdevops/contracts/environments/events';
import type { EventInfo } from '@dreamdevops/contracts/event';
import { summarizeRecordedEvent } from '@dreamdevops/contracts/events';
import { InvitationRevoked, MemberRemoved, RoleGranted, UserInvited } from '@dreamdevops/contracts/identity-access/events';
import { ReleaseMerged, ReleasePublished, ReleaseStarted } from '@dreamdevops/contracts/releases/events';
import { RepositoryCreated, RepositoryCreationFailed } from '@dreamdevops/contracts/source-governance/events';
import {
  CompanyProvisioned,
  CompanyProvisioningFailed,
  CompanyReactivated,
  CompanyRenamed,
  CompanySuspended,
} from '@dreamdevops/contracts/tenancy/events';
import type { DomainEvent } from '@dreamdevops/shared-kernel';

/**
 * The events people can be notified about. Which ones is this context's choice; what each
 * is, and how it reads, is its publisher's, in its contract.
 */
const NOTIFIABLE: readonly EventInfo[] = [
  UserInvited,
  RoleGranted,
  MemberRemoved,
  InvitationRevoked,
  CompanyRenamed,
  CompanySuspended,
  CompanyReactivated,
  CompanyProvisioned,
  CompanyProvisioningFailed,
  CompanyEditionChanged,
  ApplicationRegistered,
  ApplicationUpdated,
  ApplicationArchived,
  ApplicationRestored,
  RepositoryCreated,
  RepositoryCreationFailed,
  BuildSucceeded,
  BuildFailed,
  ReleaseStarted,
  ReleaseMerged,
  ReleasePublished,
  EnvironmentCreated,
  EnvironmentArchived,
  TargetConnected,
  TargetLost,
  TargetRevoked,
  DeploymentRequested,
  DeploymentRejected,
  DeploymentSucceeded,
  DeploymentFailed,
  DeploymentAborted,
  EnvironmentSecretSet,
  AlertTriggered,
  AlertResolved,
];

/** The company events people can be notified about, with a description of each. */
export const NOTIFIABLE_EVENTS: Readonly<Record<string, string>> = Object.fromEntries(
  NOTIFIABLE.map((definition) => [definition.type, definition.description]),
);

/** A one-line message about an event, for chat, as its contract words it. */
export function summarize(event: DomainEvent, companyName: string): string {
  return `${companyName}: ${summarizeRecordedEvent(event.eventType, event.payload)}`;
}
