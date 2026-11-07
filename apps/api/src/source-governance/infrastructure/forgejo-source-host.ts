import type { BlueprintFile } from '../../blueprints/domain/blueprint.ts';
import { PermanentSourceError, type RepositorySpec, type SourceHost } from '../application/ports.ts';
import { type GitFlowPolicy, TEAMS, type TeamKey } from '../domain/git-flow.ts';

export interface ForgejoSourceOptions {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs?: number;
}

interface ForgejoTeam {
  id: number;
  name: string;
}

interface ForgejoRepository {
  id: number;
  description: string;
  empty: boolean;
  archived: boolean;
  default_branch: string;
}

const PAGE_SIZE = 50;

/**
 * The Forgejo adapter for repositories, teams and branch rules. Repositories belong to
 * the company's organization, which the bot owns. A repository's description records
 * the application ID, which proves an existing repository is ours before anything
 * changes it.
 */
export class ForgejoSourceHost implements SourceHost {
  readonly #options: ForgejoSourceOptions;

  constructor(options: ForgejoSourceOptions) {
    this.#options = options;
  }

  async ensureTeams(organization: string): Promise<void> {
    const existing = await this.#teams(organization);
    for (const team of TEAMS) {
      const body = {
        name: team.key,
        description: team.description,
        permission: team.permission,
        includes_all_repositories: true,
        can_create_org_repo: false,
        // Releases and tags come only from the platform, so people can only read them.
        units_map: {
          'repo.code': team.permission,
          'repo.pulls': team.permission,
          'repo.issues': team.permission,
          'repo.wiki': team.permission,
          'repo.releases': 'read',
          'repo.actions': 'read',
          'repo.packages': 'read',
        },
      };
      const current = existing.get(team.key);
      const response =
        current === undefined
          ? await this.#request('POST', `/orgs/${segment(organization)}/teams`, body)
          : await this.#request('PATCH', `/teams/${current.id}`, body);
      await expectOk(response, `set up the ${team.key} team`);
    }
  }

  async ensureRepository(spec: RepositorySpec): Promise<{ id: string; empty: boolean }> {
    const marker = ownershipMarker(spec.applicationId);
    let response = await this.#request('GET', repoPath(spec));
    if (response.status === 404) {
      const created = await this.#request('POST', `/orgs/${segment(spec.organization)}/repos`, {
        name: spec.name,
        description: marker,
        private: true,
        auto_init: false,
        default_branch: 'main',
      });
      if (created.status !== 409) {
        await expectOk(created, 'create the repository');
      }
      response = await this.#request('GET', repoPath(spec));
    }
    await expectOk(response, 'read the repository');
    const repository = (await response.json()) as ForgejoRepository;
    if (repository.description !== marker) {
      throw new PermanentSourceError(`A repository named "${spec.name}" exists but belongs to something else.`);
    }
    return { id: String(repository.id), empty: repository.empty };
  }

  async commitInitialFiles(spec: RepositorySpec, files: readonly BlueprintFile[], message: string): Promise<void> {
    const response = await this.#request('POST', `${repoPath(spec)}/contents`, {
      branch: 'main',
      message,
      files: files.map((file) => ({
        operation: 'create',
        path: file.path,
        content: file.content.toString('base64'),
      })),
    });
    await expectOk(response, 'commit the scaffold');
  }

  async applyGitFlow(spec: RepositorySpec, policy: GitFlowPolicy): Promise<void> {
    const branch = await this.#request('POST', `${repoPath(spec)}/branches`, {
      new_branch_name: policy.defaultBranch,
      old_branch_name: 'main',
      old_ref_name: 'main',
    });
    if (branch.status !== 409) {
      await expectOk(branch, `create the ${policy.defaultBranch} branch`);
    }
    await expectOk(
      await this.#request('PATCH', repoPath(spec), { default_branch: policy.defaultBranch }),
      'set the default branch',
    );

    const rulesResponse = await this.#request('GET', `${repoPath(spec)}/branch_protections`);
    await expectOk(rulesResponse, 'read the branch rules');
    const existingRules = new Set(((await rulesResponse.json()) as { rule_name: string }[]).map((rule) => rule.rule_name));
    for (const rule of policy.branches) {
      const body = {
        rule_name: rule.pattern,
        enable_push: rule.directPush === 'platform',
        enable_push_whitelist: rule.directPush === 'platform',
        push_whitelist_usernames: rule.directPush === 'platform' ? [this.#options.username] : [],
        enable_merge_whitelist: false,
        required_approvals: rule.requiredApprovals,
        enable_approvals_whitelist: true,
        approvals_whitelist_teams: [rule.approvingTeam],
        block_on_rejected_reviews: true,
        dismiss_stale_approvals: true,
        apply_to_admins: true,
      };
      const response = existingRules.has(rule.pattern)
        ? await this.#request('PATCH', `${repoPath(spec)}/branch_protections/${segment(rule.pattern)}`, body)
        : await this.#request('POST', `${repoPath(spec)}/branch_protections`, body);
      await expectOk(response, `protect ${rule.pattern}`);
    }

    const tagsResponse = await this.#request('GET', `${repoPath(spec)}/tag_protections`);
    await expectOk(tagsResponse, 'read the tag rules');
    const tagRules = (await tagsResponse.json()) as { id: number; name_pattern: string }[];
    for (const pattern of policy.platformTags) {
      const body = { name_pattern: pattern, whitelist_usernames: [this.#options.username], whitelist_teams: [] };
      const current = tagRules.find((rule) => rule.name_pattern === pattern);
      const response =
        current === undefined
          ? await this.#request('POST', `${repoPath(spec)}/tag_protections`, body)
          : await this.#request('PATCH', `${repoPath(spec)}/tag_protections/${current.id}`, body);
      await expectOk(response, `protect ${pattern} tags`);
    }
  }

  async setArchived(spec: RepositorySpec, archived: boolean): Promise<void> {
    const response = await this.#request('PATCH', repoPath(spec), { archived });
    if (response.status === 404) {
      return;
    }
    await expectOk(response, archived ? 'archive the repository' : 'restore the repository');
  }

  async userExists(username: string): Promise<boolean> {
    const response = await this.#request('GET', `/users/${segment(username)}`);
    if (response.status === 404) {
      return false;
    }
    await expectOk(response, 'look up a user');
    return true;
  }

  async teamMembers(organization: string, team: TeamKey): Promise<string[]> {
    const id = await this.#teamId(organization, team);
    if (id === null) {
      return [];
    }
    const members: string[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.#request('GET', `/teams/${id}/members?limit=${PAGE_SIZE}&page=${page}`);
      await expectOk(response, `read the ${team} team`);
      const batch = (await response.json()) as { login: string }[];
      members.push(...batch.map((user) => user.login));
      if (batch.length < PAGE_SIZE) {
        return members;
      }
    }
  }

  async addTeamMember(organization: string, team: TeamKey, username: string): Promise<void> {
    const id = await this.#requireTeam(organization, team);
    await expectOk(await this.#request('PUT', `/teams/${id}/members/${segment(username)}`), `add someone to ${team}`);
  }

  async removeTeamMember(organization: string, team: TeamKey, username: string): Promise<void> {
    const id = await this.#requireTeam(organization, team);
    const response = await this.#request('DELETE', `/teams/${id}/members/${segment(username)}`);
    if (response.status !== 404) {
      await expectOk(response, `remove someone from ${team}`);
    }
  }

  async #teams(organization: string): Promise<Map<string, ForgejoTeam>> {
    const response = await this.#request('GET', `/orgs/${segment(organization)}/teams?limit=${PAGE_SIZE}`);
    await expectOk(response, 'read the teams');
    return new Map(((await response.json()) as ForgejoTeam[]).map((team) => [team.name, team]));
  }

  async #teamId(organization: string, team: TeamKey): Promise<number | null> {
    return (await this.#teams(organization)).get(team)?.id ?? null;
  }

  async #requireTeam(organization: string, team: TeamKey): Promise<number> {
    const id = await this.#teamId(organization, team);
    if (id === null) {
      throw new Error(`The ${team} team doesn't exist yet.`);
    }
    return id;
  }

  async #request(method: string, path: string, body?: object): Promise<Response> {
    const credentials = Buffer.from(`${this.#options.username}:${this.#options.password}`).toString('base64');
    try {
      return await fetch(`${this.#options.url.replace(/\/$/, '')}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 30_000),
      });
    } catch {
      throw new Error('The Git service could not be reached.');
    }
  }
}

export function ownershipMarker(applicationId: string): string {
  return `Managed by DreamDevOps for application ${applicationId}. Do not edit this description.`;
}

function repoPath(spec: RepositorySpec): string {
  return `/repos/${segment(spec.organization)}/${segment(spec.name)}`;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

async function expectOk(response: Response, action: string): Promise<void> {
  if (response.ok) {
    return;
  }
  if (response.status === 401 || response.status === 403) {
    throw new PermanentSourceError(`The Git service refused the platform's credentials to ${action}.`);
  }
  // Server errors may pass, so they are retried. Details stay out of the message.
  throw new Error(`The Git service could not ${action} (status ${response.status}).`);
}
