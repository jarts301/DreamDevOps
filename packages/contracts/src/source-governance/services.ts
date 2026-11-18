/** What Source governance answers for other contexts: where each application's repository is, and Git work on it. */

export type RepositoryStatus = 'creating' | 'ready' | 'failed';

/** An application's repository, by its organization and name. */
export interface RepositorySpec {
  readonly organization: string;
  readonly name: string;
  readonly applicationId: string;
}

/** Where an application's repository is, and whether it's ready. */
export interface RepositoryLocation {
  readonly applicationId: string;
  readonly organization: string;
  readonly name: string;
  readonly status: RepositoryStatus;
  /** The blueprint version it was created from, whose runtime settings deployments use. */
  readonly blueprint: { readonly key: string; readonly version: string } | null;
}

export const REPOSITORY_LOOKUP = Symbol('REPOSITORY_LOOKUP');

/**
 * Where an application's repository is. Every method runs in the current company, so
 * another company's repository is never found.
 */
export interface RepositoryLookup {
  find(applicationId: string): Promise<RepositoryLocation | null>;
  findByName(organization: string, name: string): Promise<RepositoryLocation | null>;
  /** Where an application's repository is, once it's ready. */
  locate(applicationId: string): Promise<RepositorySpec | null>;
  /** The repository's branches, for choosing which to build. Empty until it's ready. */
  branches(applicationId: unknown): Promise<string[]>;
}

/** A status shown on a commit, such as a check that ran on it. */
export interface CommitStatus {
  readonly context: string;
  readonly state: 'pending' | 'success' | 'failure' | 'error';
  readonly description: string;
  readonly targetUrl?: string;
}

export interface PullRequestState {
  readonly number: number;
  readonly merged: boolean;
  /** The commit the merge made, once it's merged. */
  readonly mergeCommit: string | null;
}

export interface PullRequestSpec {
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export const REPOSITORY_GIT = Symbol('REPOSITORY_GIT');

/**
 * The Git work other contexts do in an application's repository: Builds reads the code
 * and reports checks on it, and Releases cuts branches, tags and pull requests. Every
 * method is safe to repeat. The Git tool itself stays Source governance's business.
 */
export interface RepositoryGit {
  /** The newest commit on a branch, or null if the branch doesn't exist. */
  branchHead(spec: RepositorySpec, branch: string): Promise<string | null>;
  /** Creates a branch from another, and returns its newest commit. */
  createBranch(spec: RepositorySpec, name: string, from: string): Promise<string>;
  /** Creates a tag on a commit. */
  createTag(spec: RepositorySpec, name: string, commit: string): Promise<void>;
  setCommitStatus(spec: RepositorySpec, commit: string, status: CommitStatus): Promise<void>;
  /** Opens a pull request, or returns the one already open. Null when there's nothing to merge. */
  openPullRequest(spec: RepositorySpec, request: PullRequestSpec): Promise<number | null>;
  /** The newest pull request from one branch into another, open or closed, or null if there's none. */
  findPullRequest(spec: RepositorySpec, head: string, base: string): Promise<PullRequestState | null>;
  /** One file at a commit, such as the Dockerfile, or null if the commit has no such file. */
  readFile(spec: RepositorySpec, commit: string, path: string): Promise<Buffer | null>;
  /** The repository's files at a commit, as a gzipped tar archive. */
  downloadArchive(spec: RepositorySpec, commit: string): Promise<ReadableStream<Uint8Array>>;
}

/** The checks the platform reports on commits, which branch rules require. */
export const TESTS_CHECK = 'dreamdevops/tests';
export const RC_IMAGE_CHECK = 'dreamdevops/rc-image';
