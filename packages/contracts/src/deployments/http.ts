import type { EnvironmentKind, ProductionConfirmation } from '../environments/http.ts';

/** Deployments' HTTP API, as the dashboard sees it. Types and plain values only, so a browser app can use them. */

/** Recreate, rolling and blue/green come with every edition. Canary and A/B are progressive, a Commercial feature. */
export const STRATEGIES = ['recreate', 'rolling', 'blue-green', 'canary', 'a-b'] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** What a deployment does: run a version, stop what runs, or apply the environment's values to what runs. */
export const DEPLOYMENT_ACTIONS = ['deploy', 'stop', 'apply'] as const;
export type DeploymentAction = (typeof DEPLOYMENT_ACTIONS)[number];

export type DeploymentStatus =
  | 'awaiting-approval'
  | 'rejected'
  | 'queued'
  | 'committed'
  | 'progressing'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'aborted'
  | 'superseded';

/** How far a rollout has come, as the target reports it. */
export interface DeploymentProgress {
  /** Flux applied the commit with this deployment. Missing until the deployment first moves. */
  readonly applied?: boolean;
  readonly desired?: number;
  readonly updated?: number;
  readonly ready?: number;
  readonly available?: number;
  /** On This machine: where people reach it, and the port it has there. */
  readonly address?: string | null;
  readonly port?: number | null;
}

/**
 * The resources a version runs with: the CPU it's guaranteed, and the most memory it may
 * use, in Kubernetes' units.
 */
export interface ResourceLimits {
  readonly cpu: string;
  readonly memory: string;
}

/** Where something runs, or ran. */
export interface DeployedApplication {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface DeployedEnvironment {
  readonly id: string;
  readonly name: string;
  readonly kind: EnvironmentKind;
}

/** The version of an application that runs, or was asked to. */
export interface DeployedVersion {
  readonly buildId: string;
  readonly kind: string;
  readonly tag: string;
  readonly version: string | null;
}

/** Someone who asked for a deployment or approved it, by name while they're still known. */
export interface DeploymentPerson {
  readonly userId: string;
  readonly displayName: string | null;
}

export interface DeploymentView {
  readonly id: string;
  readonly application: DeployedApplication;
  readonly environment: DeployedEnvironment;
  readonly version: DeployedVersion;
  readonly strategy: Strategy;
  readonly status: DeploymentStatus;
  readonly message: string | null;
  readonly progress: DeploymentProgress;
  readonly rollbackOf: string | null;
  readonly commit: string | null;
  readonly requestedBy: DeploymentPerson | null;
  readonly approvedBy: DeploymentPerson | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  /** What it does: run a version, remove what runs, or run it again with the values as they are now. */
  readonly action: DeploymentAction;
  /** Why it was asked for, as typed. */
  readonly reason: string | null;
  /** The CPU and memory the version runs with, once it's committed, such as { cpu: '250m', memory: '256Mi' }. */
  readonly limits: ResourceLimits | null;
}

/** A version of one application running in one environment. */
export interface RunningVersion {
  readonly deploymentId: string;
  readonly application: DeployedApplication;
  readonly environment: DeployedEnvironment;
  readonly version: DeployedVersion;
  readonly strategy: Strategy;
  readonly limits: ResourceLimits | null;
  /** When it started running. */
  readonly since: string | null;
  /** What runs the environment, such as kubernetes, or local for This machine. */
  readonly provider: string | null;
  /** Where people reach it, when the platform knows, such as on This machine. */
  readonly address: string | null;
  /** The environment's values changed since it started, so Apply now would start it with the new ones. */
  readonly settingsChanged: boolean;
}

/** Deploys a version of an application to an environment. Production needs its name typed to confirm. */
export interface RequestDeployment extends ProductionConfirmation {
  /** The environment's ID. */
  readonly environment: string;
  /** The build ID of the version. */
  readonly version: string;
  readonly strategy: Strategy;
}

/** Stops what runs of an application in an environment, or runs it again with the environment's values as they are now. */
export interface ChangeRunning extends ProductionConfirmation {
  /** The environment's ID. */
  readonly environment: string;
}
