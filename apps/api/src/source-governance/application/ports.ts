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
  /** Whether a person has a Git account yet. Accounts are created on their first sign-in. */
  userExists(username: string): Promise<boolean>;
  teamMembers(organization: string, team: TeamKey): Promise<string[]>;
  addTeamMember(organization: string, team: TeamKey, username: string): Promise<void>;
  removeTeamMember(organization: string, team: TeamKey, username: string): Promise<void>;
}

/** Retrying can't help, such as when someone else owns a repository with the same name. */
export class PermanentSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSourceError';
  }
}
