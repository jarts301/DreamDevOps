import type { DomainEvent } from '@dreamdevops/shared-kernel';

/**
 * The events this module publishes. They're a contract: the module that will set up
 * each environment's infrastructure will react to them, so their names and fields must
 * stay compatible, or come with a new event version.
 *
 * Events about production carry the reason given for the change.
 */
export interface HostingTargetConnectedPayload {
  readonly targetId: string;
  readonly name: string;
  readonly provider: string;
}

export interface HostingTargetUpdatedPayload {
  readonly targetId: string;
  readonly name: string;
  readonly provider: string;
  readonly previousName?: string;
  readonly settingsChanged: boolean;
  /** Whether production environments run on it, which makes the change protected. */
  readonly servesProduction: boolean;
  readonly reason: string | null;
}

export interface HostingTargetStatusPayload {
  readonly targetId: string;
  readonly name: string;
  readonly provider: string;
}

export interface EnvironmentPayload {
  readonly environmentId: string;
  readonly applicationId: string;
  /** The application's name when it happened, for people reading the history. */
  readonly applicationName: string;
  readonly name: string;
  readonly slug: string;
  readonly production: boolean;
}

export interface EnvironmentCreatedPayload extends EnvironmentPayload {
  readonly targetId: string | null;
  readonly provider: string | null;
}

export interface EnvironmentRenamedPayload extends EnvironmentPayload {
  readonly previousName: string;
  readonly reason: string | null;
}

/** The environment moves to another place to run, such as from a self-hosted cluster to a cloud. */
export interface EnvironmentTargetSwitchedPayload extends EnvironmentPayload {
  readonly targetId: string | null;
  readonly provider: string | null;
  readonly previousTargetId: string | null;
  readonly previousProvider: string | null;
  readonly reason: string | null;
}

export interface EnvironmentProtectionPayload extends EnvironmentPayload {
  readonly reason: string | null;
}

export type HostingTargetConnected = DomainEvent<'HostingTargetConnected', HostingTargetConnectedPayload>;
export type HostingTargetUpdated = DomainEvent<'HostingTargetUpdated', HostingTargetUpdatedPayload>;
export type HostingTargetArchived = DomainEvent<'HostingTargetArchived', HostingTargetStatusPayload>;
export type HostingTargetRestored = DomainEvent<'HostingTargetRestored', HostingTargetStatusPayload>;
export type EnvironmentCreated = DomainEvent<'EnvironmentCreated', EnvironmentCreatedPayload>;
export type EnvironmentRenamed = DomainEvent<'EnvironmentRenamed', EnvironmentRenamedPayload>;
export type EnvironmentTargetSwitched = DomainEvent<'EnvironmentTargetSwitched', EnvironmentTargetSwitchedPayload>;
export type EnvironmentProtected = DomainEvent<'EnvironmentProtected', EnvironmentProtectionPayload>;
export type EnvironmentUnprotected = DomainEvent<'EnvironmentUnprotected', EnvironmentProtectionPayload>;
export type EnvironmentArchived = DomainEvent<'EnvironmentArchived', EnvironmentPayload>;
export type EnvironmentRestored = DomainEvent<'EnvironmentRestored', EnvironmentPayload>;

/** What every deployment event says: which version goes where. */
export interface DeploymentPayload {
  readonly deploymentId: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly applicationId: string;
  readonly applicationName: string;
  readonly production: boolean;
  /** Deploy, move to another target, or stop. */
  readonly kind: 'deploy' | 'move' | 'stop';
  /** The version deployed, or stopped. */
  readonly version: string | null;
  /** The kind of image, such as release or release-candidate. */
  readonly imageKind: string | null;
  readonly targetId: string;
  readonly targetName: string;
  readonly provider: string;
  /** For a move, where it ran before. */
  readonly previousTargetId: string | null;
}

export interface DeploymentQueuedPayload extends DeploymentPayload {
  /** Why, as the person said. Optional, and kept in the audit log. */
  readonly reason: string | null;
}

export interface DeploymentSucceededPayload extends DeploymentPayload {
  /** Where people reach it, if it listens on a port. */
  readonly address: string | null;
}

export interface DeploymentFailedPayload extends DeploymentPayload {
  /** The step that failed. */
  readonly step: string | null;
  readonly error: string;
  /** The version still running after the failure, if any: the one before it, restored. */
  readonly stillRunning: string | null;
}

export type DeploymentQueued = DomainEvent<'DeploymentQueued', DeploymentQueuedPayload>;
export type DeploymentSucceeded = DomainEvent<'DeploymentSucceeded', DeploymentSucceededPayload>;
export type DeploymentFailed = DomainEvent<'DeploymentFailed', DeploymentFailedPayload>;

/**
 * A variable or secret was added, changed or removed. Events never hold values, not even
 * of plain variables, so the audit log and chat never show one.
 */
export interface EnvironmentVariablePayload {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly applicationId: string;
  readonly applicationName: string;
  readonly production: boolean;
  readonly name: string;
  readonly secret: boolean;
  /** Why, as the person said. Required for production. */
  readonly reason: string | null;
}

export interface EnvironmentVariableSetPayload extends EnvironmentVariablePayload {
  readonly change: 'added' | 'changed';
}

export type EnvironmentVariableSet = DomainEvent<'EnvironmentVariableSet', EnvironmentVariableSetPayload>;
export type EnvironmentVariableRemoved = DomainEvent<'EnvironmentVariableRemoved', EnvironmentVariablePayload>;
