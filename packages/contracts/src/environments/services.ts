import type { CompanyId } from '@dreamdevops/shared-kernel';
import type { EnvironmentView } from './http.ts';

/** What Environments answers for other contexts. */

export const ENVIRONMENT_DIRECTORY = Symbol('ENVIRONMENT_DIRECTORY');

/** The current company's environments. Another company's are never found. */
export interface EnvironmentDirectory {
  /** One environment, with its target. Throws a not-found error if the company has none with this ID. */
  get(environmentId: unknown): Promise<EnvironmentView>;
}

/** The values an application runs with in an environment. Secrets' values stay in the secret store. */
export interface ResolvedConfig {
  readonly variables: Readonly<Record<string, string>>;
  /** Where its secrets are in the store: the environment's shared ones, then its own. */
  readonly secretPaths: { readonly shared: string; readonly application: string };
  readonly hasSharedSecrets: boolean;
  readonly hasApplicationSecrets: boolean;
}

export const ENVIRONMENT_VALUES = Symbol('ENVIRONMENT_VALUES');

/** An environment's variables and secrets, as what runs there gets them. */
export interface EnvironmentValues {
  resolve(environmentId: string, application: { readonly id: string; readonly slug: string }): Promise<ResolvedConfig>;
  /** A hash of the values an application runs with, to tell when they've changed since it started. */
  fingerprint(environmentId: string, applicationId: string): Promise<string>;
  /** The fingerprints of several applications' values, in the order asked, read together. */
  fingerprints(places: readonly { readonly environmentId: string; readonly applicationId: string }[]): Promise<string[]>;
  /** The secrets' values, for runtimes the platform drives itself, such as This machine. */
  openSecrets(environmentId: string, applicationSlug: string): Promise<Record<string, string>>;
}

/** An environment's Git repository, which its target's Flux applies. */
export interface EnvironmentRepository {
  readonly organization: string;
  readonly name: string;
  /** Recorded in the repository, so an existing one is proven to be ours. */
  readonly environmentId: string;
}

/** A file to write, or to delete when its content is null. */
export interface FileChange {
  readonly path: string;
  readonly content: string | null;
}

export const ENVIRONMENT_GITOPS = Symbol('ENVIRONMENT_GITOPS');

/** What Deployments writes to run versions in an environment whose target applies its repository. */
export interface EnvironmentGitOps {
  /** The environment's repository, made if it's missing. */
  repositoryOf(environmentId: string): Promise<EnvironmentRepository>;
  /** The files under a folder, by path. */
  readFolder(repository: EnvironmentRepository, folder: string): Promise<Map<string, string>>;
  /** Commits the changes to main in one commit, and returns its SHA. */
  commit(repository: EnvironmentRepository, message: string, changes: readonly FileChange[]): Promise<string>;
}

/** Which target an agent's token belongs to. */
export interface TargetIdentity {
  readonly companyId: CompanyId;
  readonly targetId: string;
  readonly environmentId: string;
}

export const TARGET_AUTHENTICATION = Symbol('TARGET_AUTHENTICATION');

/** Checks what targets' agents and collectors prove themselves with, for the contexts they talk to. */
export interface TargetAuthentication {
  /** Checks an agent's access token. Throws an unauthorized error if it isn't valid. */
  authenticate(accessToken: string | undefined): Promise<TargetIdentity>;
  /** The agent reports in, with its versions, and its target counts as seen. Checks its access token as authenticate does. */
  heartbeat(
    accessToken: string | undefined,
    input: { readonly agentVersion?: unknown; readonly kubernetesVersion?: unknown },
  ): Promise<TargetIdentity & { readonly heartbeatSeconds: number }>;
  /** Checks the token a target's collector sends its telemetry with. */
  authenticateTelemetry(token: string | undefined): Promise<TargetIdentity>;
}
