import {
  type GitHosting,
  type GitInitialFiles,
  type GitOrganization,
  type GitOrganizationErasure,
  type GitOrganizationRequest,
  type GitRepository,
  type GitRepositoryRequest,
  ProvisioningError,
} from '../src/tenancy/application/ports.ts';

interface StoredRepository {
  readonly description: string;
  files: ReadonlyMap<string, string>;
  commits: number;
  topics: readonly string[];
}

interface StoredOrganization {
  displayName: string;
  readonly companyId: string;
  readonly repositories: Map<string, StoredRepository>;
}

/** A fake GitHosting for fast tests. The same contract tests run against this and Forgejo. */
export class InMemoryGitHosting implements GitHosting {
  readonly #organizations = new Map<string, StoredOrganization>();
  readonly #accounts = new Set<string>();
  #failuresLeft = 0;
  calls = 0;

  async ensureOrganization(request: GitOrganizationRequest): Promise<GitOrganization> {
    this.calls += 1;
    if (this.#failuresLeft > 0) {
      this.#failuresLeft -= 1;
      throw new Error('Git hosting is unreachable.');
    }
    const existing = this.#organizations.get(request.name);
    if (existing !== undefined) {
      if (existing.companyId !== request.companyId) {
        throw new ProvisioningError(`An organization named "${request.name}" isn't managed by DreamDevOps.`);
      }
      existing.displayName = request.displayName;
    } else if (this.#accounts.has(request.name)) {
      throw new ProvisioningError(`The name "${request.name}" is already used by an account.`);
    } else {
      this.#organizations.set(request.name, {
        displayName: request.displayName,
        companyId: request.companyId,
        repositories: new Map(),
      });
    }
    return { name: request.name, url: `http://git.test/${request.name}` };
  }

  async eraseOrganization(request: GitOrganizationErasure): Promise<void> {
    this.calls += 1;
    if (this.#failuresLeft > 0) {
      this.#failuresLeft -= 1;
      throw new Error('Git hosting is unreachable.');
    }
    const existing = this.#organizations.get(request.name);
    if (existing === undefined || existing.companyId !== request.companyId) {
      return;
    }
    if (existing.repositories.size > 0) {
      throw new ProvisioningError('The Git organization still has repositories.');
    }
    this.#organizations.delete(request.name);
  }

  async ensureRepository(request: GitRepositoryRequest): Promise<GitRepository> {
    this.#call();
    const organization = this.#organizations.get(request.organization);
    if (organization === undefined) {
      throw new Error(`There is no organization "${request.organization}".`);
    }
    // Like Forgejo with auto_init, a new repository starts with a commit holding a README.
    const repository = organization.repositories.get(request.name) ?? {
      description: request.description,
      files: new Map([['README.md', `# ${request.name}\n\n${request.description}\n`]]),
      commits: 1,
      topics: [],
    };
    repository.topics = [...request.topics];
    organization.repositories.set(request.name, repository);
    return { name: request.name, url: `http://git.test/${request.organization}/${request.name}` };
  }

  async addInitialFiles(request: GitInitialFiles): Promise<'added' | 'skipped'> {
    this.#call();
    const repository = this.#organizations.get(request.organization)?.repositories.get(request.repository);
    if (repository === undefined) {
      throw new Error(`There is no repository "${request.organization}/${request.repository}".`);
    }
    if (repository.commits > 1) {
      return 'skipped';
    }
    repository.files = new Map([...repository.files, ...request.files.map((file) => [file.path, file.content] as const)]);
    repository.commits += 1;
    this.lastCommitMessage = request.message;
    return 'added';
  }

  async eraseRepository(request: { readonly organization: string; readonly name: string }): Promise<void> {
    this.#call();
    this.#organizations.get(request.organization)?.repositories.delete(request.name);
  }

  lastCommitMessage: string | null = null;

  /** A repository someone made outside DreamDevOps, with their own commits. */
  addRepository(organization: string, repository: string): void {
    this.#organizations
      .get(organization)
      ?.repositories.set(repository, { description: '', files: new Map([['README.md', '# Theirs']]), commits: 2, topics: [] });
  }

  topicsOf(organization: string, repository: string): readonly string[] | null {
    return this.#organizations.get(organization)?.repositories.get(repository)?.topics ?? null;
  }

  /** The repository's files on main, or null if it doesn't exist. */
  filesOf(organization: string, repository: string): ReadonlyMap<string, string> | null {
    return this.#organizations.get(organization)?.repositories.get(repository)?.files ?? null;
  }

  hasRepository(organization: string, repository: string): boolean {
    return this.#organizations.get(organization)?.repositories.has(repository) ?? false;
  }

  #call(): void {
    this.calls += 1;
    if (this.#failuresLeft > 0) {
      this.#failuresLeft -= 1;
      throw new Error('Git hosting is unreachable.');
    }
  }

  removeRepository(organization: string, repository: string): void {
    this.#organizations.get(organization)?.repositories.delete(repository);
  }

  /** Makes the next calls fail as if Git hosting were down. */
  failNext(times: number): void {
    this.#failuresLeft = times;
  }

  recover(): void {
    this.#failuresLeft = 0;
  }

  /** An account that isn't an organization, so its name can't be used for one. */
  addAccount(name: string): void {
    this.#accounts.add(name);
  }

  displayNameOf(name: string): string | null {
    return this.#organizations.get(name)?.displayName ?? null;
  }
}
