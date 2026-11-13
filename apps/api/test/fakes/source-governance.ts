import type { BlueprintFile } from '../../src/blueprints/domain/blueprint.ts';
import {
  type CommitStatus,
  PermanentSourceError,
  type PullRequestSpec,
  type PullRequestState,
  type RepositorySpec,
  type SourceHost,
  type WebhookSpec,
} from '../../src/source-governance/application/ports.ts';
import { TEAMS, type TeamKey } from '../../src/source-governance/domain/git-flow.ts';

interface FakeRepository {
  readonly id: string;
  readonly applicationId: string;
  files: BlueprintFile[];
  gitFlow: boolean;
  archived: boolean;
  teamsGranted: boolean;
  webhook: WebhookSpec | null;
  readonly branches: Map<string, string>;
  readonly tags: Map<string, string>;
  readonly statuses: { commit: string; status: CommitStatus }[];
  readonly pullRequests: { number: number; head: string; base: string; title: string; mergeCommit: string | null }[];
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
      teamsGranted: false,
      webhook: null,
      branches: new Map<string, string>(),
      tags: new Map<string, string>(),
      statuses: [],
      pullRequests: [],
    };
    this.repositories.set(key, repository);
    return { id: repository.id, empty: repository.files.length === 0 };
  }

  #commits = 0;

  async commitInitialFiles(spec: RepositorySpec, files: readonly BlueprintFile[]): Promise<void> {
    const repository = this.#repository(spec);
    repository.files = [...files];
    repository.branches.set('main', this.#nextCommit());
  }

  async applyGitFlow(spec: RepositorySpec): Promise<void> {
    const repository = this.#repository(spec);
    repository.gitFlow = true;
    if (!repository.branches.has('develop')) {
      repository.branches.set('develop', repository.branches.get('main')!);
    }
  }

  async grantTeams(spec: RepositorySpec): Promise<void> {
    this.#repository(spec).teamsGranted = true;
  }

  async ensureWebhook(spec: RepositorySpec, hook: WebhookSpec): Promise<void> {
    this.#repository(spec).webhook = hook;
  }

  async branchHead(spec: RepositorySpec, branch: string): Promise<string | null> {
    return this.#repository(spec).branches.get(branch) ?? null;
  }

  async listBranches(spec: RepositorySpec): Promise<string[]> {
    return [...this.#repository(spec).branches.keys()].sort();
  }

  async createBranch(spec: RepositorySpec, name: string, from: string): Promise<string> {
    const repository = this.#repository(spec);
    if (!repository.branches.has(name)) {
      repository.branches.set(name, repository.branches.get(from)!);
    }
    return repository.branches.get(name)!;
  }

  async createTag(spec: RepositorySpec, name: string, commit: string): Promise<void> {
    const tags = this.#repository(spec).tags;
    if (tags.has(name) && tags.get(name) !== commit) {
      throw new PermanentSourceError(`The ${name} tag already points to another commit.`);
    }
    tags.set(name, commit);
  }

  async setCommitStatus(spec: RepositorySpec, commit: string, status: CommitStatus): Promise<void> {
    this.#repository(spec).statuses.push({ commit, status });
  }

  async readFile(spec: RepositorySpec, _commit: string, path: string): Promise<Buffer | null> {
    return this.#repository(spec).files.find((file) => file.path === path)?.content ?? null;
  }

  async findPullRequest(spec: RepositorySpec, head: string, base: string): Promise<PullRequestState | null> {
    const pull = this.#repository(spec)
      .pullRequests.filter((candidate) => candidate.head === head && candidate.base === base)
      .at(-1);
    return pull === undefined ? null : { number: pull.number, merged: pull.mergeCommit !== null, mergeCommit: pull.mergeCommit };
  }

  /** Merges a pull request as someone would in the Git tool, and returns the merge commit. */
  merge(organization: string, name: string, head: string, base: string): string {
    const repository = this.repositories.get(`${organization}/${name}`)!;
    const pull = repository.pullRequests.find((candidate) => candidate.head === head && candidate.base === base)!;
    const commit = this.push(organization, name, base);
    pull.mergeCommit = commit;
    return commit;
  }

  /** Replaces a file, as a push that changes it would. */
  writeFile(organization: string, name: string, path: string, content: string): void {
    const repository = this.repositories.get(`${organization}/${name}`)!;
    repository.files = [...repository.files.filter((file) => file.path !== path), { path, content: Buffer.from(content) }];
  }

  async openPullRequest(spec: RepositorySpec, request: PullRequestSpec): Promise<number | null> {
    const repository = this.#repository(spec);
    const existing = repository.pullRequests.find((pull) => pull.head === request.head && pull.base === request.base);
    if (existing !== undefined) {
      return existing.number;
    }
    const number = repository.pullRequests.length + 1;
    repository.pullRequests.push({ number, head: request.head, base: request.base, title: request.title, mergeCommit: null });
    return number;
  }

  async downloadArchive(spec: RepositorySpec, commit: string): Promise<ReadableStream<Uint8Array>> {
    const content = new TextEncoder().encode(`archive of ${spec.organization}/${spec.name} at ${commit}`);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(content);
        controller.close();
      },
    });
  }

  /** Adds a commit to a branch, as a push would, and returns it. */
  push(organization: string, name: string, branch: string): string {
    const commit = this.#nextCommit();
    this.repositories.get(`${organization}/${name}`)!.branches.set(branch, commit);
    return commit;
  }

  #nextCommit(): string {
    this.#commits += 1;
    return this.#commits.toString(16).padStart(40, '0');
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
