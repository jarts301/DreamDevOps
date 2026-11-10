export const ENVIRONMENT_REPOSITORIES = Symbol('ENVIRONMENT_REPOSITORIES');
export const PULL_ACCOUNTS = Symbol('PULL_ACCOUNTS');
export const SECRET_STORE = Symbol('SECRET_STORE');

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
  /** Keeps the platform's own token alive. */
  renew(): Promise<void>;
}
