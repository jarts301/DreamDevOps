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
