import type { BlueprintFile } from '../../src/blueprints/domain/blueprint.ts';
import { PermanentSourceError, type RepositorySpec, type SourceHost } from '../../src/source-governance/application/ports.ts';
import { TEAMS, type TeamKey } from '../../src/source-governance/domain/git-flow.ts';

interface FakeRepository {
  readonly id: string;
  readonly applicationId: string;
  files: BlueprintFile[];
  gitFlow: boolean;
  archived: boolean;
}

/** Keeps repositories and teams in memory, and can be told to fail. */
export class FakeSourceHost implements SourceHost {
  readonly repositories = new Map<string, FakeRepository>();
  readonly teams = new Map<string, Map<TeamKey, Set<string>>>();
  /** Usernames that have signed in to the Git tool at least once. */
  readonly users = new Set<string>();
  /** Errors to throw, one per repository creation, before it starts succeeding. */
  readonly failures: Error[] = [];

  async ensureTeams(organization: string): Promise<void> {
    if (!this.teams.has(organization)) {
      this.teams.set(organization, new Map(TEAMS.map((team) => [team.key, new Set<string>()])));
    }
  }

  async ensureRepository(spec: RepositorySpec): Promise<{ id: string; empty: boolean }> {
    const failure = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    const key = `${spec.organization}/${spec.name}`;
    const existing = this.repositories.get(key);
    if (existing !== undefined && existing.applicationId !== spec.applicationId) {
      throw new PermanentSourceError(`A repository named "${spec.name}" exists but belongs to something else.`);
    }
    const repository = existing ?? {
      id: `repo-${this.repositories.size + 1}`,
      applicationId: spec.applicationId,
      files: [],
      gitFlow: false,
      archived: false,
    };
    this.repositories.set(key, repository);
    return { id: repository.id, empty: repository.files.length === 0 };
  }

  async commitInitialFiles(spec: RepositorySpec, files: readonly BlueprintFile[]): Promise<void> {
    this.#repository(spec).files = [...files];
  }

  async applyGitFlow(spec: RepositorySpec): Promise<void> {
    this.#repository(spec).gitFlow = true;
  }

  async setArchived(spec: RepositorySpec, archived: boolean): Promise<void> {
    const repository = this.repositories.get(`${spec.organization}/${spec.name}`);
    if (repository !== undefined) {
      repository.archived = archived;
    }
  }

  async userExists(username: string): Promise<boolean> {
    return this.users.has(username.toLowerCase());
  }

  async teamMembers(organization: string, team: TeamKey): Promise<string[]> {
    return [...(this.teams.get(organization)?.get(team) ?? [])];
  }

  async addTeamMember(organization: string, team: TeamKey, username: string): Promise<void> {
    this.teams.get(organization)!.get(team)!.add(username.toLowerCase());
  }

  async removeTeamMember(organization: string, team: TeamKey, username: string): Promise<void> {
    this.teams.get(organization)?.get(team)?.delete(username.toLowerCase());
  }

  /** Which team each person is in, for one organization. */
  teamOf(organization: string): Record<string, TeamKey> {
    const result: Record<string, TeamKey> = {};
    for (const [team, members] of this.teams.get(organization) ?? []) {
      for (const member of members) {
        result[member] = team;
      }
    }
    return result;
  }

  #repository(spec: RepositorySpec): FakeRepository {
    return this.repositories.get(`${spec.organization}/${spec.name}`)!;
  }
}
