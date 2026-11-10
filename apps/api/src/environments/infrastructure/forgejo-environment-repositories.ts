import { randomBytes } from 'node:crypto';
import type {
  EnvironmentRepositories,
  EnvironmentRepository,
  FileChange,
  PullAccounts,
  PullCredentials,
} from '../application/ports.ts';

export interface ForgejoAccount {
  readonly username: string;
  readonly password: string;
}

export interface ForgejoEnvironmentOptions {
  readonly url: string;
  /** The bot, which owns each company's organization. */
  readonly bot: ForgejoAccount;
  readonly timeoutMs?: number;
}

const BRANCH = 'main';

/**
 * Environment repositories in the company's Forgejo organization. The description
 * records the environment ID, which proves an existing repository is ours. No team gets
 * access: only the platform writes, and only the target's deploy key reads.
 */
export class ForgejoEnvironmentRepositories implements EnvironmentRepositories {
  readonly #client: ForgejoClient;

  readonly #bot: ForgejoAccount;

  constructor(options: ForgejoEnvironmentOptions) {
    this.#client = new ForgejoClient(options.url, options.timeoutMs);
    this.#bot = options.bot;
  }

  async ensure(repository: EnvironmentRepository): Promise<void> {
    const marker = environmentMarker(repository.environmentId);
    const existing = await this.#request('GET', repoPath(repository));
    if (existing.ok) {
      const { description } = (await existing.json()) as { description: string };
      if (description !== marker) {
        throw new Error(`The repository ${repository.name} exists but doesn't belong to this environment.`);
      }
      return;
    }
    if (existing.status !== 404) {
      await expectOk(existing, 'read the environment repository');
    }
    const created = await this.#request('POST', `/orgs/${segment(repository.organization)}/repos`, {
      name: repository.name,
      description: marker,
      private: true,
      auto_init: true,
      default_branch: BRANCH,
      readme: 'Default',
    });
    // Another request may have created it at the same moment.
    if (created.status !== 409) {
      await expectOk(created, 'create the environment repository');
    }
  }

  async setDeployKey(repository: EnvironmentRepository, title: string, publicKey: string): Promise<void> {
    await this.removeDeployKeys(repository);
    await expectOk(
      await this.#request('POST', `${repoPath(repository)}/keys`, { title, key: publicKey, read_only: true }),
      'add the deploy key',
    );
  }

  async removeDeployKeys(repository: EnvironmentRepository, title?: string): Promise<void> {
    const response = await this.#request('GET', `${repoPath(repository)}/keys?limit=50`);
    if (response.status === 404) {
      return;
    }
    await expectOk(response, 'read the deploy keys');
    const keys = (await response.json()) as { id: number; title: string }[];
    for (const key of keys.filter((candidate) => title === undefined || candidate.title === title)) {
      const removed = await this.#request('DELETE', `${repoPath(repository)}/keys/${key.id}`);
      if (removed.status !== 404) {
        await expectOk(removed, 'remove a deploy key');
      }
    }
  }

  async readFolder(repository: EnvironmentRepository, folder: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const walk = async (path: string): Promise<void> => {
      const response = await this.#request('GET', `${repoPath(repository)}/contents/${encodePath(path)}?ref=${BRANCH}`);
      if (response.status === 404) {
        return;
      }
      await expectOk(response, 'read the environment repository');
      const entries = (await response.json()) as { type: string; path: string }[] | { type: string; path: string; content: string };
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        if (entry.type === 'dir') {
          await walk(entry.path);
        } else if (entry.type === 'file') {
          files.set(entry.path, await this.#readFile(repository, entry.path));
        }
      }
    };
    await walk(folder);
    return files;
  }

  async commit(repository: EnvironmentRepository, message: string, changes: readonly FileChange[]): Promise<string> {
    const files = [];
    for (const change of changes) {
      const sha = await this.#fileSha(repository, change.path);
      if (change.content === null) {
        if (sha !== null) {
          files.push({ operation: 'delete', path: change.path, sha });
        }
      } else {
        files.push({
          operation: sha === null ? 'create' : 'update',
          path: change.path,
          content: Buffer.from(change.content).toString('base64'),
          ...(sha !== null && { sha }),
        });
      }
    }
    if (files.length === 0) {
      return this.#head(repository);
    }
    const response = await this.#request('POST', `${repoPath(repository)}/contents`, {
      branch: BRANCH,
      message,
      files,
      author: { name: 'DreamDevOps', email: 'deployments@dreamdevops.invalid' },
    });
    await expectOk(response, 'commit to the environment repository');
    const { commit } = (await response.json()) as { commit: { sha: string } };
    return commit.sha;
  }

  async #head(repository: EnvironmentRepository): Promise<string> {
    const response = await this.#request('GET', `${repoPath(repository)}/branches/${BRANCH}`);
    await expectOk(response, 'read the environment repository');
    return ((await response.json()) as { commit: { id: string } }).commit.id;
  }

  async #fileSha(repository: EnvironmentRepository, path: string): Promise<string | null> {
    const response = await this.#request('GET', `${repoPath(repository)}/contents/${encodePath(path)}?ref=${BRANCH}`);
    if (response.status === 404) {
      return null;
    }
    await expectOk(response, 'read the environment repository');
    return ((await response.json()) as { sha: string }).sha;
  }

  async #readFile(repository: EnvironmentRepository, path: string): Promise<string> {
    const response = await this.#request('GET', `${repoPath(repository)}/raw/${encodePath(path)}?ref=${BRANCH}`);
    await expectOk(response, 'read the environment repository');
    return response.text();
  }

  #request(method: string, path: string, body?: object): Promise<Response> {
    return this.#client.request(this.#bot, method, path, body);
  }
}

const PULL_TEAM = 'targets';
const PULL_TOKEN_NAME = 'dreamdevops-pull';

export interface ForgejoPullAccountOptions extends ForgejoEnvironmentOptions {
  /** A Forgejo administrator, used only to create and reset pull accounts. */
  readonly admin: ForgejoAccount;
}

/**
 * Each company's read-only account for pulling its images. It belongs only to the
 * company's targets team, which can read packages and no code. The administrator
 * creates the account; the bot, as the organization's owner, adds it to the team.
 */
export class ForgejoPullAccounts implements PullAccounts {
  readonly #client: ForgejoClient;
  readonly #options: ForgejoPullAccountOptions;

  constructor(options: ForgejoPullAccountOptions) {
    this.#client = new ForgejoClient(options.url, options.timeoutMs);
    this.#options = options;
  }

  async create(organization: string): Promise<PullCredentials> {
    const username = pullUsername(organization);
    const password = randomBytes(24).toString('base64url');
    const { admin, bot } = this.#options;

    // A new password each time, so the platform can sign in as the account to make its token.
    const existing = await this.#client.request(admin, 'GET', `/users/${segment(username)}`);
    if (existing.status === 404) {
      await expectOk(
        await this.#client.request(admin, 'POST', '/admin/users', {
          username,
          email: `${username}@pull.dreamdevops.invalid`,
          password,
          must_change_password: false,
          send_notify: false,
          visibility: 'private',
        }),
        'create the pull account',
      );
    } else {
      await expectOk(existing, 'read the pull account');
      await expectOk(
        await this.#client.request(admin, 'PATCH', `/admin/users/${segment(username)}`, {
          login_name: username,
          source_id: 0,
          password,
          must_change_password: false,
        }),
        'reset the pull account',
      );
    }

    const teamId = await this.#ensureTeam(organization);
    await expectOk(
      await this.#client.request(bot, 'PUT', `/teams/${teamId}/members/${segment(username)}`),
      'add the pull account to its team',
    );

    const account = { username, password };
    const old = await this.#client.request(account, 'DELETE', `/users/${segment(username)}/tokens/${PULL_TOKEN_NAME}`);
    if (old.status !== 404) {
      await expectOk(old, 'replace the pull token');
    }
    const created = await this.#client.request(account, 'POST', `/users/${segment(username)}/tokens`, {
      name: PULL_TOKEN_NAME,
      scopes: ['read:package'],
    });
    await expectOk(created, 'create the pull token');
    return { username, token: ((await created.json()) as { sha1: string }).sha1 };
  }

  async #ensureTeam(organization: string): Promise<number> {
    const { bot } = this.#options;
    const body = {
      name: PULL_TEAM,
      description: 'Deployment targets. They pull images, and read nothing else.',
      permission: 'read',
      includes_all_repositories: false,
      can_create_org_repo: false,
      units_map: { 'repo.packages': 'read' },
    };
    const teams = await this.#client.request(bot, 'GET', `/orgs/${segment(organization)}/teams?limit=50`);
    await expectOk(teams, 'read the teams');
    const current = ((await teams.json()) as { id: number; name: string }[]).find((team) => team.name === PULL_TEAM);
    if (current !== undefined) {
      await expectOk(await this.#client.request(bot, 'PATCH', `/teams/${current.id}`, body), 'set up the targets team');
      return current.id;
    }
    const created = await this.#client.request(bot, 'POST', `/orgs/${segment(organization)}/teams`, body);
    await expectOk(created, 'create the targets team');
    return ((await created.json()) as { id: number }).id;
  }
}

/** Forgejo usernames are at most 40 characters. */
export function pullUsername(organization: string): string {
  return `${organization.slice(0, 35)}-pull`;
}

export function environmentMarker(environmentId: string): string {
  return `Managed by DreamDevOps for environment ${environmentId}. Do not edit this repository.`;
}

class ForgejoClient {
  readonly #url: string;
  readonly #timeoutMs: number;

  constructor(url: string, timeoutMs = 30_000) {
    this.#url = url.replace(/\/$/, '');
    this.#timeoutMs = timeoutMs;
  }

  async request(account: ForgejoAccount, method: string, path: string, body?: object): Promise<Response> {
    const credentials = Buffer.from(`${account.username}:${account.password}`).toString('base64');
    try {
      return await fetch(`${this.#url}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new Error('The Git service could not be reached.');
    }
  }
}

function repoPath(repository: EnvironmentRepository): string {
  return `/repos/${segment(repository.organization)}/${segment(repository.name)}`;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function encodePath(path: string): string {
  return path.split('/').map(segment).join('/');
}

async function expectOk(response: Response, action: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`The Git service could not ${action} (status ${response.status}).`);
  }
}
