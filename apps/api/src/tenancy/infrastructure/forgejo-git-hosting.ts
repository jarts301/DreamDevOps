import {
  type GitHosting,
  type GitInitialFiles,
  type GitOrganization,
  type GitOrganizationErasure,
  type GitOrganizationRequest,
  type GitRepository,
  type GitRepositoryRequest,
  ProvisioningError,
} from '../application/ports.ts';

export interface ForgejoOptions {
  /** Such as http://localhost:3000, without /api/v1. */
  readonly url: string;
  readonly username: string;
  /** The account's password, or better, one of its access tokens. */
  readonly password: string;
  readonly timeoutMs?: number;
  /** Replaced in tests. */
  readonly fetch?: typeof fetch;
}

interface ForgejoOrganization {
  readonly full_name?: string;
  readonly description?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
// Adding a scaffold sends every file of a project in one request, lockfiles included.
const FILES_TIMEOUT_MS = 120_000;
const BRANCH = 'main';
const AUTHOR = { name: 'DreamDevOps', email: 'noreply@dreamdevops.invalid' };
// A company's slug can't change, so these are the ways forward.
const NAME_TAKEN_HELP = 'Free the name in Git hosting and retry, or close this company and create it with another slug.';

/** The Forgejo adapter. Forgejo's API and its concepts stay inside this file. */
export class ForgejoGitHosting implements GitHosting {
  readonly #baseUrl: string;
  readonly #authorization: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: ForgejoOptions) {
    this.#baseUrl = options.url.replace(/\/$/, '');
    this.#authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? fetch;
  }

  async ensureOrganization(request: GitOrganizationRequest): Promise<GitOrganization> {
    const path = `/orgs/${encodeURIComponent(request.name)}`;
    const organization = { name: request.name, url: `${this.#baseUrl}/${encodeURIComponent(request.name)}` };

    const existing = await this.#call('GET', path);
    if (existing.status === 200) {
      const found = (await existing.json()) as ForgejoOrganization;
      if (!(found.description ?? '').includes(request.companyId)) {
        throw new ProvisioningError(
          `Git hosting already has an organization named "${request.name}" that DreamDevOps doesn't manage. ${NAME_TAKEN_HELP}`,
        );
      }
      if (found.full_name !== request.displayName) {
        const updated = await this.#call('PATCH', path, { full_name: request.displayName });
        if (updated.status !== 200) {
          throw this.#failure(updated, 'PATCH /orgs/:name');
        }
      }
      return organization;
    }
    if (existing.status !== 404) {
      throw this.#failure(existing, 'GET /orgs/:name');
    }

    const created = await this.#call('POST', '/orgs', {
      username: request.name,
      full_name: request.displayName,
      description: describe(request.companyId),
      visibility: 'private',
      repo_admin_change_team_access: false,
    });
    if (created.status === 201) {
      return organization;
    }
    // Forgejo answers 422 when a user already has the name or the name is reserved.
    if (created.status === 409 || created.status === 422) {
      throw new ProvisioningError(
        `Git hosting refused the organization name "${request.name}". It's reserved or already used by an account. ${NAME_TAKEN_HELP}`,
      );
    }
    throw this.#failure(created, 'POST /orgs');
  }

  async eraseOrganization(request: GitOrganizationErasure): Promise<void> {
    const path = `/orgs/${encodeURIComponent(request.name)}`;

    const existing = await this.#call('GET', path);
    if (existing.status === 404) {
      return;
    }
    if (existing.status !== 200) {
      throw this.#failure(existing, 'GET /orgs/:name');
    }
    const found = (await existing.json()) as ForgejoOrganization;
    if (!(found.description ?? '').includes(request.companyId)) {
      return;
    }

    const repositories = await this.#call('GET', `${path}/repos?limit=1`);
    if (repositories.status !== 200) {
      throw this.#failure(repositories, 'GET /orgs/:name/repos');
    }
    if (((await repositories.json()) as unknown[]).length > 0) {
      throw new ProvisioningError(
        'The Git organization still has repositories. Delete or move them in Git hosting, then retry.',
      );
    }

    const deleted = await this.#call('DELETE', path);
    if (deleted.status !== 204 && deleted.status !== 404) {
      throw this.#failure(deleted, 'DELETE /orgs/:name');
    }
  }

  async ensureRepository(request: GitRepositoryRequest): Promise<GitRepository> {
    const path = repositoryPath(request.organization, request.name);

    const existing = await this.#call('GET', path);
    if (existing.status === 404) {
      const created = await this.#call('POST', `/orgs/${encodeURIComponent(request.organization)}/repos`, {
        name: request.name,
        description: request.description,
        private: true,
        // Forgejo makes the first commit, with a README, so the repository is never empty.
        auto_init: true,
        readme: 'Default',
        default_branch: BRANCH,
      });
      // 409 means someone made it between the two calls, so it's there now.
      if (created.status === 422) {
        throw new ProvisioningError(`Git hosting refused the repository name "${request.name}". It may be reserved.`);
      }
      if (created.status !== 201 && created.status !== 409) {
        throw this.#failure(created, 'POST /orgs/:name/repos');
      }
    } else if (existing.status !== 200) {
      throw this.#failure(existing, 'GET /repos/:owner/:name');
    }

    const topics = await this.#call('PUT', `${path}/topics`, { topics: request.topics });
    if (topics.status !== 204 && topics.status !== 200) {
      throw this.#failure(topics, 'PUT /repos/:owner/:name/topics');
    }
    return {
      name: request.name,
      url: `${this.#baseUrl}/${encodeURIComponent(request.organization)}/${encodeURIComponent(request.name)}`,
    };
  }

  async addInitialFiles(request: GitInitialFiles): Promise<'added' | 'skipped'> {
    const path = repositoryPath(request.organization, request.repository);
    const commits = await this.#commitCount(path);
    if (commits > 1) {
      return 'skipped';
    }

    // Files Forgejo made with the repository, such as its README, are replaced.
    const existing = commits === 0 ? new Map<string, string>() : await this.#topLevelFiles(path);
    const response = await this.#call(
      'POST',
      `${path}/contents`,
      {
        branch: BRANCH,
        message: request.message,
        author: AUTHOR,
        committer: AUTHOR,
        files: request.files.map((file) => {
          const content = Buffer.from(file.content, 'utf8').toString('base64');
          const sha = existing.get(file.path);
          return sha === undefined
            ? { operation: 'create', path: file.path, content }
            : { operation: 'update', path: file.path, content, sha };
        }),
      },
      FILES_TIMEOUT_MS,
    );
    if (response.status === 200 || response.status === 201) {
      return 'added';
    }
    if (response.status === 409 || response.status === 422) {
      // Another run added them at the same moment.
      if ((await this.#commitCount(path)) > 1) {
        return 'skipped';
      }
      throw new ProvisioningError("Git hosting refused the application's starting files.");
    }
    throw this.#failure(response, 'POST /repos/:owner/:name/contents');
  }

  async eraseRepository(request: { readonly organization: string; readonly name: string }): Promise<void> {
    const deleted = await this.#call('DELETE', repositoryPath(request.organization, request.name));
    if (deleted.status !== 204 && deleted.status !== 404) {
      throw this.#failure(deleted, 'DELETE /repos/:owner/:name');
    }
  }

  /** 0, 1, or 2 for two or more. Forgejo answers 409 for a repository with no commits. */
  async #commitCount(path: string): Promise<number> {
    const response = await this.#call(
      'GET',
      `${path}/commits?sha=${BRANCH}&limit=2&stat=false&verification=false&files=false`,
    );
    if (response.status === 409 || response.status === 404) {
      return 0;
    }
    if (response.status !== 200) {
      throw this.#failure(response, 'GET /repos/:owner/:name/commits');
    }
    return ((await response.json()) as unknown[]).length;
  }

  /** The files at the top of main, with the SHA Forgejo needs to replace each. */
  async #topLevelFiles(path: string): Promise<Map<string, string>> {
    const response = await this.#call('GET', `${path}/contents?ref=${BRANCH}`);
    if (response.status === 404) {
      return new Map();
    }
    if (response.status !== 200) {
      throw this.#failure(response, 'GET /repos/:owner/:name/contents');
    }
    const entries = (await response.json()) as { path: string; sha: string; type: string }[];
    return new Map(entries.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry.sha]));
  }

  async #call(method: string, path: string, body?: object, timeoutMs = this.#timeoutMs): Promise<Response> {
    return this.#fetch(`${this.#baseUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: this.#authorization,
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /**
   * Credentials problems need someone to fix the settings. Anything else may pass. The
   * message names the endpoint but not the organization, because it reaches logs and
   * job records, which erasing a company can't reach.
   */
  #failure(response: Response, endpoint: string): Error {
    if (response.status === 401 || response.status === 403) {
      return new ProvisioningError("Git hosting refused DreamDevOps's credentials. Check the API's Forgejo settings.");
    }
    return new Error(`Forgejo answered ${response.status} to ${endpoint}.`);
  }
}

function repositoryPath(organization: string, name: string): string {
  return `/repos/${encodeURIComponent(organization)}/${encodeURIComponent(name)}`;
}

function describe(companyId: string): string {
  return `Managed by DreamDevOps for company ${companyId}.`;
}
