import type { BlueprintFile } from '../../blueprints/domain/blueprint.ts';
import type { GitFlowPolicy, TeamKey } from '../domain/git-flow.ts';

export const SOURCE_HOST = Symbol('SOURCE_HOST');

export interface RepositorySpec {
  readonly organization: string;
  readonly name: string;
  readonly applicationId: string;
}

/**
 * The Git tool that holds each application's repository. Every method is safe to
 * repeat, because a step may run again after a failure.
 */
export interface SourceHost {
  /** Creates the organization's teams, or brings them up to date. */
  ensureTeams(organization: string): Promise<void>;
  /** Creates a private, empty repository, or checks that an existing one is ours. */
  ensureRepository(spec: RepositorySpec): Promise<{ readonly id: string; readonly empty: boolean }>;
  /** Commits files as the first commit on main. Only call it on an empty repository. */
  commitInitialFiles(spec: RepositorySpec, files: readonly BlueprintFile[], message: string): Promise<void>;
  /** Creates the branches, sets the default branch and applies branch and tag protection. */
  applyGitFlow(spec: RepositorySpec, policy: GitFlowPolicy): Promise<void>;
  setArchived(spec: RepositorySpec, archived: boolean): Promise<void>;
  /** Gives the organization's teams access to the repository. Teams don't cover every repository. */
  grantTeams(spec: RepositorySpec): Promise<void>;
  /** Creates the repository's webhook, or brings it up to date. */
  ensureWebhook(spec: RepositorySpec, hook: WebhookSpec): Promise<void>;
  /** The newest commit on a branch, or null if the branch doesn't exist. */
  branchHead(spec: RepositorySpec, branch: string): Promise<string | null>;
  listBranches(spec: RepositorySpec): Promise<string[]>;
  /** Creates a branch from another, and returns its newest commit. Safe to repeat. */
  createBranch(spec: RepositorySpec, name: string, from: string): Promise<string>;
  /** Creates a tag on a commit. Safe to repeat for the same commit. */
  createTag(spec: RepositorySpec, name: string, commit: string): Promise<void>;
  setCommitStatus(spec: RepositorySpec, commit: string, status: CommitStatus): Promise<void>;
  /** Opens a pull request, or returns the one already open. Null when there's nothing to merge. */
  openPullRequest(spec: RepositorySpec, request: PullRequestSpec): Promise<number | null>;
  /** One file at a commit, such as the Dockerfile, or null if the commit has no such file. */
  readFile(spec: RepositorySpec, commit: string, path: string): Promise<Buffer | null>;
  /** The newest pull request from one branch into another, open or closed, or null if there's none. */
  findPullRequest(spec: RepositorySpec, head: string, base: string): Promise<PullRequestState | null>;
  /** The repository's files at a commit, as a gzipped tar archive. */
  downloadArchive(spec: RepositorySpec, commit: string): Promise<ReadableStream<Uint8Array>>;
  /** Whether a person has a Git account yet. Accounts are created on their first sign-in. */
  userExists(username: string): Promise<boolean>;
  teamMembers(organization: string, team: TeamKey): Promise<string[]>;
  addTeamMember(organization: string, team: TeamKey, username: string): Promise<void>;
  removeTeamMember(organization: string, team: TeamKey, username: string): Promise<void>;
}

export interface WebhookSpec {
  readonly url: string;
  readonly secret: string;
  readonly events: readonly string[];
}

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

/** Retrying can't help, such as when someone else owns a repository with the same name. */
export class PermanentSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSourceError';
  }
}
