export const BUILD_SOURCE = Symbol('BUILD_SOURCE');
export const IMAGE_BUILDER = Symbol('IMAGE_BUILDER');
export const IMAGE_SCANNER = Symbol('IMAGE_SCANNER');
export const IMAGE_REGISTRY = Symbol('IMAGE_REGISTRY');

/** An application's repository in the Git tool. */
export interface RepositoryRef {
  readonly organization: string;
  readonly name: string;
}

export interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  /** The commit the merge made on the target branch. */
  readonly mergeCommit: string | null;
  /** The full name of the repository the changes come from. It differs for a fork. */
  readonly head: { readonly branch: string; readonly commit: string; readonly repository: string | null };
  readonly base: { readonly branch: string };
  readonly url: string;
  readonly author: string | null;
}

/** A checked-out copy of the source at one commit. */
export interface Workspace {
  readonly directory: string;
  /** A file's text, or null when it's missing or isn't a regular file, such as a link. */
  readFile(path: string): Promise<string | null>;
  dispose(): Promise<void>;
}

/**
 * The Git tool, as builds need it. Every method that changes something is safe to
 * repeat, because a step may run again after a failure.
 */
export interface BuildSource {
  /** Creates the webhook that reports new branches and merges, or brings it up to date. */
  ensureWebhook(repository: RepositoryRef, hook: { readonly url: string; readonly secret: string }): Promise<void>;
  /** A branch and the commit at its tip, or null if it doesn't exist. */
  branch(repository: RepositoryRef, name: string): Promise<{ readonly name: string; readonly commit: string } | null>;
  /** Creates a branch from another one. If it already exists, returns it as it is. */
  createBranch(
    repository: RepositoryRef,
    name: string,
    from: string,
  ): Promise<{ readonly name: string; readonly commit: string }>;
  pullRequest(repository: RepositoryRef, number: number): Promise<PullRequest | null>;
  /** The most recently updated pull requests in one state. */
  pullRequests(repository: RepositoryRef, state: 'open' | 'closed'): Promise<PullRequest[]>;
  /** Downloads the source at one commit into a new folder. */
  checkout(repository: RepositoryRef, commit: string): Promise<Workspace>;
  /**
   * Tags a commit. Safe to repeat, but refuses with a PermanentBuildError if the tag
   * already points somewhere else.
   */
  createTag(repository: RepositoryRef, tag: { readonly name: string; readonly commit: string; readonly message: string }): Promise<void>;
}

export interface ImageDetails {
  /** The user the image runs as. Empty means root. */
  readonly user: string;
  readonly healthcheck: boolean;
  readonly sizeBytes: number;
  readonly exposedPorts: readonly string[];
}

/** Builds images, and publishes them. Images are named like registry/organization/application:version. */
export interface ImageBuilder {
  build(request: {
    readonly directory: string;
    readonly image: string;
    readonly labels: Readonly<Record<string, string>>;
  }): Promise<void>;
  inspect(image: string): Promise<ImageDetails>;
  /** Publishes a built image under another name in the registry. */
  push(image: string, target: string): Promise<void>;
  /** Removes local images once a build is done with them. Missing ones are ignored. */
  remove(images: readonly string[]): Promise<void>;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'unknown'];

export interface Vulnerability {
  readonly id: string;
  readonly severity: Severity;
  readonly packageName: string;
  readonly installedVersion: string;
  readonly fixedVersion: string | null;
  readonly title: string | null;
}

export interface ScanReport {
  readonly counts: Readonly<Record<Severity, number>>;
  /** The most severe findings, most severe first. */
  readonly findings: readonly Vulnerability[];
}

export interface ImageScanner {
  /** Shown with the results, such as "Trivy". Null when scanning is turned off. */
  readonly name: string | null;
  scan(image: string): Promise<ScanReport>;
}

export interface StoredSignature {
  readonly payload: Buffer;
  readonly signature: string;
}

/** The image registry, for what the container CLI can't do: digests and signatures. */
export interface ImageRegistry {
  /** Where images live, such as localhost:3000. It starts every image name. */
  readonly host: string;
  /** The digest a tag points to. */
  digest(repository: string, tag: string): Promise<string>;
  /** Stores a signature beside the image, and returns the tag it's under. */
  attachSignature(repository: string, digest: string, signature: StoredSignature): Promise<string>;
  /** Every signature stored for an image. */
  signatures(repository: string, digest: string): Promise<StoredSignature[]>;
}

/** Retrying can't help, such as when a pull request was closed. The message is shown to people. */
export class PermanentBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentBuildError';
  }
}
