import type { DeploymentAction, ResourceLimits } from '@dreamdevops/contracts/deployments/http';
import type { LogEntry } from '@dreamdevops/contracts/deployments/services';
import type { EventLog, Transactional } from '@dreamdevops/shared-kernel';
import type { DeploymentStatus, Progress } from '../domain/deployment.ts';
import type { Strategy } from '../domain/manifests.ts';

/** Runs applications on targets the platform drives itself, such as This machine. */
export const HOST_RUNTIME = Symbol('HOST_RUNTIME');

/** A target, as a runtime needs it. */
export interface HostTarget {
  readonly id: string;
  /** The provider's settings, such as the host name people reach This machine by. */
  readonly settings: Readonly<Record<string, string | number>>;
}

export interface ContainerRequest {
  /** The application's container in the environment, the same for every version. */
  readonly name: string;
  /** The environment's own network. */
  readonly network: string;
  /** The image by digest, such as localhost:3000/acme/billing-api@sha256:…. */
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  /**
   * The environment variables it starts with, secrets included. Runtimes must never log
   * them, or put them where other users of the host can read them, such as a command's arguments.
   */
  readonly environment: Readonly<Record<string, string>>;
  /** The port it had before, which it keeps when it's still free, so its address stays the same. */
  readonly preferredPort: number | null;
}

/** The most a container may use, so one application can't starve its host. */
export interface ContainerLimits {
  /** CPU cores, such as 1 or 0.5. */
  readonly cpus: number;
  readonly memoryBytes: number;
}

export interface StartedContainer {
  /** The port people reach it on, or null when the image listens on none. */
  readonly port: number | null;
  readonly address: string | null;
  readonly limits: ContainerLimits;
}

export interface Health {
  readonly healthy: boolean;
  /** What the image's health check, or the container, last said. */
  readonly detail: string;
}

// A line an application wrote is this context's published language, kept in its contracts.
export type { LogEntry } from '@dreamdevops/contracts/deployments/services';

/**
 * Runs images on one kind of target. Every method is safe to repeat, because a deployment
 * starts again from the beginning after a temporary failure.
 */
export interface HostRuntime {
  /** Why it can't deploy on this server, such as being turned off, or null when it can. */
  unavailableReason(): string | null;
  /** Downloads the image to the host. */
  pull(target: HostTarget, image: string): Promise<void>;
  /** Starts the image as the application's container, keeping the version before it, stopped. */
  start(target: HostTarget, request: ContainerRequest): Promise<StartedContainer>;
  /** Waits until the container's health check passes, it stops, or time runs out. */
  waitUntilHealthy(target: HostTarget, name: string, timeoutMs: number): Promise<Health>;
  /** Removes the version kept for rolling back, once the new one is healthy. */
  commit(target: HostTarget, name: string): Promise<void>;
  /** Removes the new version, and starts the one before it again. Returns whether one runs again. */
  rollBack(target: HostTarget, name: string): Promise<boolean>;
  /** Stops and removes the application's containers, and the network once nothing else uses it. */
  remove(target: HostTarget, name: string, network: string): Promise<void>;
  /** The container's latest lines since a moment, oldest first. None when it doesn't exist. */
  logs(target: HostTarget, name: string, options: { readonly since: Date; readonly limit: number }): Promise<LogEntry[]>;
}

/** Retrying can't help, such as when an image can't start. The message is shown to people. */
export class PermanentDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentDeploymentError';
  }
}

/** A deployment as Deployments keeps it, with the names of who asked and who approved. */
export interface StoredDeployment {
  readonly id: string;
  readonly environmentId: string;
  readonly applicationId: string;
  readonly buildId: string;
  readonly strategy: Strategy;
  readonly status: DeploymentStatus;
  readonly rollbackOf: string | null;
  readonly commitSha: string | null;
  readonly progress: Progress;
  readonly message: string | null;
  readonly requestedBy: string | null;
  readonly requesterName: string | null;
  readonly approvedBy: string | null;
  readonly approverName: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly finishedAt: Date | null;
  readonly reason: string | null;
  readonly action: DeploymentAction;
  readonly limits: ResourceLimits | null;
  /** The fingerprint of the environment's values it started with. */
  readonly configHash: string | null;
}

export interface NewDeployment {
  readonly id: string;
  readonly environmentId: string;
  readonly applicationId: string;
  readonly buildId: string;
  readonly strategy: Strategy;
  readonly status: DeploymentStatus;
  readonly rollbackOf: string | null;
  readonly requestedBy: string;
  readonly reason: string | null;
  readonly action: DeploymentAction;
}

/** Deployments of one application, or in one environment, or both. */
export interface DeploymentFilter {
  readonly applicationId?: string;
  readonly environmentId?: string;
}

export type CommandAction = 'promote' | 'abort';

/** The current company's deployments and the commands for their agents, in one transaction. */
export interface DeploymentsSession extends EventLog {
  /** The newest deployments first. */
  list(filter: DeploymentFilter, limit: number): Promise<StoredDeployment[]>;
  /** What runs now: deployments that succeeded, other than stops, the newest first. */
  running(filter: DeploymentFilter): Promise<StoredDeployment[]>;
  /** One deployment, locked until the transaction ends when asked. */
  find(id: string, options?: { readonly lock?: boolean }): Promise<StoredDeployment | null>;
  /** An environment's deployments in these statuses, always in the same order, so locking them one by one can't deadlock. */
  inEnvironment(environmentId: string, statuses: readonly DeploymentStatus[]): Promise<StoredDeployment[]>;
  /** What ran well before a deployment, of another version only when asked. */
  previousSuccess(deployment: StoredDeployment, options: { readonly otherVersion: boolean }): Promise<StoredDeployment | null>;
  /** The applications the deployments with these IDs are of. */
  applicationsOf(deploymentIds: readonly string[]): Promise<string[]>;
  /** The port the application last had on This machine, or null. */
  lastPort(environmentId: string, applicationId: string): Promise<number | null>;
  /** Adds a deployment. False when another of the application is still going in the environment. */
  add(deployment: NewDeployment): Promise<boolean>;
  /** Approves a deployment, which queues it, or rejects it, which ends it. */
  decide(id: string, approved: boolean, decidedBy: string): Promise<void>;
  /** A queued deployment is committed to Git, with what it runs with. False when it isn't queued any more. */
  markCommitted(
    id: string,
    committed: { readonly commitSha: string; readonly limits: ResourceLimits | null; readonly configHash: string | null },
  ): Promise<boolean>;
  /** A rollout moved on, as its target reported, and maybe finished. */
  updateRollout(
    id: string,
    rollout: { readonly status: DeploymentStatus; readonly progress: Progress; readonly message: string | null; readonly finished: boolean },
  ): Promise<void>;
  /** A run on This machine is under way. */
  markProgressing(id: string, progress: Progress, message: string): Promise<void>;
  /** A run on This machine ended. False when it had ended already. */
  finishRun(
    id: string,
    run: {
      readonly status: 'succeeded' | 'failed';
      readonly message: string;
      readonly progress: Progress;
      readonly limits: ResourceLimits | null;
      readonly configHash: string | null;
    },
  ): Promise<boolean>;
  fail(id: string, message: string): Promise<void>;
  /** Only the newest version that ran well runs: the earlier ones are replaced. */
  supersedeOthers(deployment: StoredDeployment): Promise<void>;
  /** Companies, of any company, with deployments that haven't moved since the cutoff. */
  stalled(cutoff: Date): Promise<{ readonly deploymentId: string; readonly companyId: string }[]>;
  hasOpenCommand(deploymentId: string, action: CommandAction): Promise<boolean>;
  addCommand(deploymentId: string, environmentId: string, action: CommandAction): Promise<void>;
  /** Has a rollback's traffic switch as soon as it's up, unless it has one already. */
  addPromoteOnce(deploymentId: string, environmentId: string): Promise<void>;
  /** The applications with commands waiting for an environment's agent. */
  applicationsWithPendingCommands(environmentId: string): Promise<string[]>;
  /** Hands the waiting commands of these applications to the environment's agent. */
  sendPendingCommands(
    environmentId: string,
    applicationIds: readonly string[],
  ): Promise<{ readonly id: string; readonly action: CommandAction; readonly applicationId: string }[]>;
  /** Records how a sent command went. */
  completeCommand(id: string, environmentId: string, result: { readonly succeeded: boolean; readonly message: string | null }): Promise<void>;
}

export const DEPLOYMENTS_STORE = Symbol('DEPLOYMENTS_STORE');

export type DeploymentsStore = Transactional<DeploymentsSession>;
