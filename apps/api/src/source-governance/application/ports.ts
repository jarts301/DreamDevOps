import type { RepositoryStatus } from '@dreamdevops/contracts/source-governance/http';
import type { EventLog, Transactional } from '@dreamdevops/shared-kernel';
import type { BlueprintFile } from '@dreamdevops/contracts/blueprints/services';
import type { RepositoryGit, RepositorySpec } from '@dreamdevops/contracts/source-governance/services';
import type { GitFlowPolicy, TeamKey } from '../domain/git-flow.ts';

// The Git work other contexts do is this context's published language, kept in its contracts.
export type {
  CommitStatus,
  PullRequestSpec,
  PullRequestState,
  RepositorySpec,
} from '@dreamdevops/contracts/source-governance/services';

export const SOURCE_HOST = Symbol('SOURCE_HOST');

/**
 * The Git tool that holds each application's repository. Every method is safe to
 * repeat, because a step may run again after a failure. It does all the Git work other
 * contexts may ask for, which this context publishes to them as RepositoryGit.
 */
export interface SourceHost extends RepositoryGit {
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
  listBranches(spec: RepositorySpec): Promise<string[]>;
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

/** Retrying can't help, such as when someone else owns a repository with the same name. */
export class PermanentSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSourceError';
  }
}

/** An application's repository, as Source governance keeps it. */
export interface StoredRepository {
  readonly applicationId: string;
  readonly organization: string;
  readonly name: string;
  readonly status: RepositoryStatus;
  /** The blueprint version it starts from, chosen once, so every try uses the same scaffold. */
  readonly blueprint: { readonly key: string; readonly version: string } | null;
  /** Failed tries in a row. */
  readonly attempts: number;
  readonly lastError: string | null;
}

/** A member of the current company, with their Git username and permissions. */
export interface MemberAccount {
  readonly userId: string;
  readonly username: string;
  readonly permissions: readonly string[];
}

/** The current company's repositories, in one transaction. */
export interface SourceSession extends EventLog {
  /** Every repository, by name. */
  list(): Promise<StoredRepository[]>;
  find(applicationId: string): Promise<StoredRepository | null>;
  findByName(organization: string, name: string): Promise<StoredRepository | null>;
  /** An application's repository, locked until the transaction ends. */
  lock(applicationId: string): Promise<StoredRepository | null>;
  /** Asks for the repository to be made, again if it failed, from its first try. */
  markCreating(applicationId: string, organization: string, name: string): Promise<void>;
  /** Claims the repository for this job for a while, unless another job's claim still holds. */
  claim(applicationId: string, seconds: number): Promise<boolean>;
  renewClaim(applicationId: string, seconds: number): Promise<void>;
  chooseBlueprint(applicationId: string, blueprint: { readonly key: string; readonly version: string }): Promise<void>;
  /** The repository is made, under a version of the rules. Releases its claim. */
  markReady(applicationId: string, externalId: string, policyVersion: number): Promise<void>;
  /** Records a failed try, and releases its claim. It's failed for good, or still being made. */
  recordFailure(applicationId: string, failure: { readonly failed: boolean; readonly attempts: number; readonly error: string }): Promise<void>;
  /** The ready repositories made under rules older than this version. */
  outdated(policyVersion: number): Promise<StoredRepository[]>;
  setPolicyVersion(applicationId: string, policyVersion: number): Promise<void>;
  /** The companies, of any company, with repositories made under rules older than this version. */
  companiesWithOutdatedRepositories(policyVersion: number): Promise<string[]>;
  /** The members with a Git username, or only one of them. */
  memberAccounts(userId?: string): Promise<MemberAccount[]>;
}

export const SOURCE_STORE = Symbol('SOURCE_STORE');

export type SourceStore = Transactional<SourceSession>;
