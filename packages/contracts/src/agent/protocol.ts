import type { EnvironmentKind } from '../environments/http.ts';

/**
 * The protocol between the platform and the agent in each target, over HTTPS under
 * /api/v1/agent. The agent only ever calls out. It's a separate program, released on its
 * own, so a change must stay compatible with agents already running: add optional fields
 * only, and keep what older agents send working.
 *
 * The agent imports these as types only, so its image needs nothing but its own code.
 */

/** POST /agent/register: the agent registers its public key with the one-time token from the dashboard. */
export interface RegistrationRequest {
  readonly registrationToken: string;
  /** The agent's Ed25519 public key, as a JSON Web Key. */
  readonly publicKey: { readonly kty: string; readonly crv: string; readonly x: string };
  readonly agentVersion: string;
  readonly kubernetesVersion: string;
}

export interface Registration {
  readonly targetId: string;
  /** Where the agent swaps signed assertions for access tokens, as the assertions' audience. */
  readonly tokenUrl: string;
  readonly heartbeatSeconds: number;
  readonly environment: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly kind: EnvironmentKind;
    readonly acceptedImages: readonly string[];
  };
}

/** POST /agent/token: an assertion signed with the agent's key, for a short-lived access token. */
export interface TokenRequest {
  readonly assertion: string;
}

export interface TokenResponse {
  readonly accessToken: string;
  /** In seconds. */
  readonly expiresIn: number;
}

/** PUT /agent/deploy-key: the read-only SSH key Flux reads the environment's repository with. */
export interface DeployKeyRequest {
  /** An ssh-ed25519 public key, in OpenSSH's format. */
  readonly publicKey: string;
}

/** GET /agent/configuration: everything a target needs to run its environment. */
export interface TargetConfiguration {
  readonly environment: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly kind: EnvironmentKind;
    readonly acceptedImages: readonly string[];
  };
  /** The company's images, and its read-only account for pulling them. */
  readonly registry: { readonly host: string; readonly organization: string; readonly username: string; readonly token: string };
  /** The only key whose signatures this environment accepts: the release key in production. */
  readonly trustedKey: string;
  /** The environment's repository, which Flux applies with the agent's deploy key. */
  readonly git: { readonly url: string; readonly branch: string; readonly knownHosts: string };
  /** A short-lived token that can only read this environment's secrets. */
  readonly secrets: { readonly url: string; readonly mount: string; readonly path: string; readonly token: string; readonly expiresAt: string };
  /** Where the target's collector sends its applications' metrics, traces and logs, and the token it sends them with. */
  readonly telemetry: { readonly endpoint: string; readonly token: string; readonly expiresAt: string };
}

/** How one deployed workload is doing, as the agent sees it in the cluster. */
export interface WorkloadReport {
  readonly deploymentId: string;
  readonly namespace: string;
  readonly name: string;
  readonly kind: 'Rollout' | 'Deployment';
  readonly phase: 'Progressing' | 'Paused' | 'Healthy' | 'Degraded' | 'Aborted';
  readonly desired: number;
  readonly updated: number;
  readonly ready: number;
  readonly available: number;
  readonly message: string | null;
}

/** Whether Flux applied the environment's repository, and which commit. */
export interface SyncReport {
  readonly revision: string | null;
  readonly ready: boolean;
  readonly message: string | null;
}

/** POST /agent/heartbeat: the agent reports in, with how the environment's rollouts are doing. */
export interface HeartbeatRequest {
  readonly agentVersion: string;
  readonly kubernetesVersion: string;
  readonly sync: SyncReport | null;
  readonly workloads: readonly WorkloadReport[];
}

/** A command for the agent: promote a blue/green rollout waiting on its preview, or abort one. */
export interface AgentCommand {
  readonly id: string;
  readonly action: 'promote' | 'abort';
  /** The rollout's namespace and name, each the application's short name. */
  readonly namespace: string;
  readonly name: string;
}

export interface HeartbeatResponse {
  /** How long to wait before the next heartbeat. */
  readonly heartbeatSeconds: number;
  readonly commands: readonly AgentCommand[];
}

/** POST /agent/commands/:id: how a command went. */
export interface CommandResult {
  readonly succeeded: boolean;
  readonly message: string | null;
}
