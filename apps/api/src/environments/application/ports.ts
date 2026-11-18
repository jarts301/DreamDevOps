import type { EnvironmentStatus, TargetStatus } from '@dreamdevops/contracts/environments/http';
import type { EnvironmentRepository, FileChange } from '@dreamdevops/contracts/environments/services';
import type { EventLog, Transactional } from '@dreamdevops/shared-kernel';
import type { EnvironmentKind } from '../domain/environment.ts';
import type { HostingProviderKey, HostingSettings } from '../domain/hosting-providers.ts';

export const ENVIRONMENT_REPOSITORIES = Symbol('ENVIRONMENT_REPOSITORIES');
export const PULL_ACCOUNTS = Symbol('PULL_ACCOUNTS');
export const SECRET_STORE = Symbol('SECRET_STORE');

// An environment's repository, and changes to it, are this context's published language, kept in its contracts.
export type { EnvironmentRepository, FileChange } from '@dreamdevops/contracts/environments/services';

/**
 * Each environment's Git repository, which its target's Flux applies. Only the platform
 * writes to it; the target reads it with a read-only deploy key.
 */
export interface EnvironmentRepositories {
  /** Creates the repository if needed, with a main branch. Safe to repeat. */
  ensure(repository: EnvironmentRepository): Promise<void>;
  /** Replaces the repository's deploy keys with this read-only one. */
  setDeployKey(repository: EnvironmentRepository, title: string, publicKey: string): Promise<void>;
  /** Removes the deploy keys with this title, or all of them. */
  removeDeployKeys(repository: EnvironmentRepository, title?: string): Promise<void>;
  /** The files under a folder, by path. */
  readFolder(repository: EnvironmentRepository, folder: string): Promise<Map<string, string>>;
  /** Commits the changes to main in one commit, and returns its SHA. */
  commit(repository: EnvironmentRepository, message: string, changes: readonly FileChange[]): Promise<string>;
}

/** A company's read-only account for pulling its images, nothing else. */
export interface PullCredentials {
  readonly username: string;
  readonly token: string;
}

export interface PullAccounts {
  /** Creates the company's pull account and a new token for it. */
  create(organization: string): Promise<PullCredentials>;
}

/** Keeps secret values. The platform writes and deletes them, but never reads them back. */
export interface SecretStore {
  /** Sets these values at the path, keeping the others there. */
  write(path: string, values: Readonly<Record<string, string>>): Promise<void>;
  /** Removes these names from the path. */
  remove(path: string, names: readonly string[]): Promise<void>;
  /** A short-lived token that can only read the secrets under this path. */
  issueReadToken(policyName: string, path: string): Promise<{ token: string; expiresAt: Date }>;
  /** Reads the values at a path with a read token, or none if nothing is there. */
  read(token: string, path: string): Promise<Record<string, string>>;
  /** Keeps the platform's own token alive. */
  renew(): Promise<void>;
}

/** An environment as Environments keeps it. */
export interface StoredEnvironment {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly kind: EnvironmentKind;
  readonly acceptsFeatureImages: boolean;
  readonly requiresApproval: boolean;
  readonly status: EnvironmentStatus;
  readonly createdAt: Date;
  readonly archivedAt: Date | null;
  /** Its Git repository's name, once it has one. */
  readonly repository: string | null;
}

/** A target as Environments keeps it, with the hashes of what its agent proves itself with. */
export interface StoredTarget {
  readonly id: string;
  readonly environmentId: string;
  readonly provider: HostingProviderKey;
  readonly settings: HostingSettings;
  readonly status: TargetStatus;
  readonly registrationTokenHash: string | null;
  readonly registrationExpiresAt: Date | null;
  readonly publicKey: string | null;
  readonly accessTokenHash: string | null;
  readonly accessTokenExpiresAt: Date | null;
  readonly agentVersion: string | null;
  readonly kubernetesVersion: string | null;
  readonly registeredAt: Date | null;
  readonly lastSeenAt: Date | null;
  readonly createdAt: Date;
}

/** A variable or a secret, for one environment's applications, or one of them. Secrets have no value here. */
export interface StoredValue {
  readonly name: string;
  readonly value: string | null;
  /** The application it's for, or null for every application of the environment. */
  readonly applicationId: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
}

/** Where a value applies: an environment, and one of its applications or all of them. */
export interface ValueScope {
  readonly environmentId: string;
  readonly applicationId: string | null;
}

export type ValueKind = 'variables' | 'secrets';

/** The current company's environments, in one transaction. */
export interface EnvironmentRecords {
  /** Production first, then by name. */
  listEnvironments(status: EnvironmentStatus): Promise<StoredEnvironment[]>;
  /** One environment, locked until the transaction ends when asked. */
  findEnvironment(id: string, options?: { readonly lock?: boolean }): Promise<StoredEnvironment | null>;
  /** Lets one environment at a time take a name in the current company. */
  lockNames(): Promise<void>;
  /** Whether another environment has this name, ignoring case, and if so, its status. */
  statusOfName(name: string, exceptId: string | null): Promise<EnvironmentStatus | null>;
  isSlugTaken(slug: string): Promise<boolean>;
  addEnvironment(environment: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly kind: EnvironmentKind;
    readonly acceptsFeatureImages: boolean;
    readonly createdBy: string;
  }): Promise<void>;
  updateEnvironment(
    id: string,
    changes: { readonly name: string; readonly acceptsFeatureImages: boolean; readonly requiresApproval: boolean },
  ): Promise<void>;
  setEnvironmentStatus(id: string, status: EnvironmentStatus): Promise<void>;
  setRepository(id: string, name: string): Promise<void>;
}

/** The current company's targets, in one transaction. */
export interface TargetRecords {
  /** Every target still in use, connected or not. */
  currentTargets(): Promise<StoredTarget[]>;
  /** An environment's target still in use, connected or not. */
  currentTarget(environmentId: string): Promise<StoredTarget | null>;
  findTarget(id: string, options?: { readonly lock?: boolean }): Promise<StoredTarget | null>;
  /** Cuts a target off: its tokens stop working at once. */
  revokeTarget(id: string, revokedBy: string): Promise<void>;
  /** Adds a cluster target waiting for its agent, and returns when its registration token expires. */
  addPendingTarget(target: {
    readonly id: string;
    readonly environmentId: string;
    readonly registrationTokenHash: string;
    readonly registrationMinutes: number;
    readonly createdBy: string;
  }): Promise<Date>;
  /** Adds a target the platform runs itself, connected at once. */
  addConnectedTarget(target: {
    readonly id: string;
    readonly environmentId: string;
    readonly provider: HostingProviderKey;
    readonly settings: HostingSettings;
    readonly createdBy: string;
  }): Promise<void>;
  /** The agent registered its key: the target is connected, and its registration token is spent. */
  completeRegistration(
    id: string,
    agent: { readonly publicKey: string; readonly agentVersion: string | null; readonly kubernetesVersion: string | null },
  ): Promise<void>;
  /** Records an assertion as used, forgetting expired ones. False when it was used before. */
  useAssertion(targetId: string, assertion: { readonly assertionId: string; readonly expiresAt: Date }): Promise<boolean>;
  setAccessToken(id: string, hash: string, minutes: number): Promise<void>;
  /** The target reported in, so it's connected. */
  markSeen(id: string): Promise<void>;
  /** Keeps the versions an agent reports, and the ones it leaves out as they were. */
  updateVersions(id: string, versions: { readonly agentVersion: string | null; readonly kubernetesVersion: string | null }): Promise<void>;
  /** Marks a connected target lost if it hasn't reported since the cutoff. Null when it has, or isn't connected. */
  markLostIfSilent(id: string, cutoff: Date): Promise<{ readonly environmentId: string; readonly lastSeenAt: Date } | null>;
  setDeployKey(targetId: string, publicKey: string): Promise<void>;
  /** Connected targets, in any company, not heard from since the cutoff. */
  silentTargets(cutoff: Date): Promise<{ readonly targetId: string; readonly companyId: string }[]>;
  /** The company a target belongs to, found without any company's context, or null. */
  companyOfTarget(targetId: string): Promise<string | null>;
}

/** The current company's variables and secrets, in one transaction. */
export interface ValueRecords {
  /** An environment's values, and with an application, that application's too, by name. */
  values(kind: ValueKind, scope: ValueScope): Promise<StoredValue[]>;
  /** The name a value has in a scope, matching this one in any case, or null. */
  nameInScope(kind: ValueKind, scope: ValueScope, name: string): Promise<string | null>;
  setVariable(scope: ValueScope, variable: { readonly name: string; readonly value: string; readonly updatedBy: string }): Promise<void>;
  /** Keeps a secret's name and size. Its value goes to the secret store. */
  setSecret(scope: ValueScope, secret: { readonly name: string; readonly bytes: number; readonly updatedBy: string }): Promise<void>;
  /** False when there's no such value. */
  removeValue(kind: ValueKind, scope: ValueScope, name: string): Promise<boolean>;
  /** The size in bytes of each value in exactly this scope. */
  sizes(scope: ValueScope): Promise<number[]>;
  /** The variables an application gets in an environment: the environment's, then its own. */
  variablesFor(environmentId: string, applicationId: string): Promise<{ readonly name: string; readonly value: string }[]>;
  /** Whether an environment has secrets for every application, and for this one. */
  secretScopes(environmentId: string, applicationId: string): Promise<{ readonly shared: boolean; readonly application: boolean }>;
  /**
   * A fingerprint of the values an application gets in an environment. It changes whenever
   * one of them is set or removed, so deployments can tell when what runs has older ones.
   */
  fingerprint(environmentId: string, applicationId: string): Promise<string>;
}

/** The company's account for pulling its images, with its token sealed. */
export interface PullAccountRecords {
  /** Lets one target at a time make the company's pull account. */
  lockPullAccount(): Promise<void>;
  pullAccount(): Promise<{ readonly username: string; readonly sealedToken: string } | null>;
  addPullAccount(username: string, sealedToken: string): Promise<void>;
}

/** Everything Environments keeps for the current company, in one transaction. */
export interface EnvironmentsSession extends EventLog, EnvironmentRecords, TargetRecords, ValueRecords, PullAccountRecords {}

export const ENVIRONMENTS_STORE = Symbol('ENVIRONMENTS_STORE');

export type EnvironmentsStore = Transactional<EnvironmentsSession>;
