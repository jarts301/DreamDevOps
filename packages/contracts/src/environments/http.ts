import type { HostingProviderKey } from './hosting.ts';

/**
 * Environments' HTTP API, as the dashboard and other contexts see it. Types and plain
 * values only, so a browser app can use them.
 */

export const ENVIRONMENT_KINDS = ['test', 'production'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

export type EnvironmentStatus = 'active' | 'archived';
export type TargetStatus = 'pending' | 'connected' | 'lost' | 'revoked';

export interface TargetView {
  readonly id: string;
  /** What runs the environment: a Kubernetes cluster with the agent, or This machine. */
  readonly provider: HostingProviderKey;
  /** The provider's settings, such as the host name people reach This machine by. */
  readonly settings: Readonly<Record<string, string | number>>;
  readonly status: TargetStatus;
  readonly registrationExpiresAt: string | null;
  readonly keyFingerprint: string | null;
  readonly agentVersion: string | null;
  readonly kubernetesVersion: string | null;
  readonly registeredAt: string | null;
  readonly lastSeenAt: string | null;
  readonly createdAt: string;
}

export interface EnvironmentView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly kind: EnvironmentKind;
  readonly acceptsFeatureImages: boolean;
  readonly acceptedImages: readonly string[];
  /** Production only: a second person approves each deployment. */
  readonly requiresApproval: boolean;
  readonly status: EnvironmentStatus;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  /** The target that runs it, unless none is connected or being connected. */
  readonly target: TargetView | null;
}

/** The shortest and longest reason the API accepts for a change to production. */
export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 500;

/**
 * What a change to production carries: its name, typed to confirm, and why, which the
 * audit log keeps. Changes to test environments need neither, and take a reason if given.
 */
export interface ProductionConfirmation {
  readonly confirmation?: string;
  /** Between MIN_REASON_LENGTH and MAX_REASON_LENGTH characters. */
  readonly reason?: string;
}

export interface CreateEnvironment {
  readonly name: string;
  readonly kind: EnvironmentKind;
  /** Test environments only. Production never runs feature images. */
  readonly acceptsFeatureImages?: boolean;
  readonly reason?: string;
}

/** Changes an environment. Fields left out stay as they are. */
export interface UpdateEnvironment extends ProductionConfirmation {
  readonly name?: string;
  readonly acceptsFeatureImages?: boolean;
  readonly requiresApproval?: boolean;
}

/** Where environments' values apply: to every application, or to one. */
export type ConfigScope = 'environment' | 'application';

export interface VariableView {
  readonly name: string;
  readonly value: string;
  readonly scope: ConfigScope;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

/** A secret shows only its name. Its value can be replaced or deleted, never read. */
export interface SecretView {
  readonly name: string;
  readonly scope: ConfigScope;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

/** An environment's variables and secrets, and with ?application=, that application's too. */
export interface EnvironmentConfigView {
  readonly variables: readonly VariableView[];
  readonly secrets: readonly SecretView[];
}

/** Sets a variable or a secret, for every application of the environment or for one. */
export interface SetValue extends ProductionConfirmation {
  readonly value: string;
  /** The application it's for. Left out, it's for every application. */
  readonly application?: string;
}

/** Where a provider runs: servers the company runs itself, or a cloud service. */
export type HostingKind = 'self-hosted' | 'cloud';

export type SettingType = 'url' | 'hostname' | 'port' | 'text';

export interface SettingDefinition {
  /** A stable key. Saved settings use it, so it must never change. */
  readonly key: string;
  readonly label: string;
  readonly type: SettingType;
  readonly required: boolean;
  /** For text settings, the form a value must have. */
  readonly pattern?: string;
  /** For optional ports, the value used when none is given. */
  readonly defaultValue?: number;
  readonly example: string;
  readonly help: string | null;
}

/** A kind of place where environments can run, and the settings it needs. */
export interface HostingProvider {
  /** A stable key. Targets and events use it, so it must never change. */
  readonly key: string;
  readonly name: string;
  readonly kind: HostingKind;
  readonly description: string;
  /**
   * Whether the platform can deploy to it yet. Others can be chosen already, so
   * environments can be planned, and will deploy once the platform supports them.
   */
  readonly deploys: boolean;
  readonly settings: readonly SettingDefinition[];
}

/** A place environments can run, and whether it can be chosen on this server. */
export interface ProviderView extends HostingProvider {
  /** Why it can't be chosen, or null when it can. */
  readonly unavailableReason: string | null;
}

/** Connects a target to an environment, where it will run. */
export interface ConnectTarget {
  /** A provider's key. A Kubernetes cluster when left out. */
  readonly provider?: string;
  readonly settings?: Readonly<Record<string, string | number>>;
}

/** A target being connected. */
export interface Connection {
  readonly targetId: string;
  readonly provider: string;
  /** For a cluster: shown once. Only its hash is stored. Null for This machine, which needs no agent. */
  readonly registrationToken: string | null;
  readonly expiresAt: string | null;
  /** For a cluster: the command to run against it. */
  readonly command: string | null;
}
