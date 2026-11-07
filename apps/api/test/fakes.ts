import type {
  AuthorizationRequest,
  CodeExchange,
  ExternalIdentity,
  IdentityProvider,
  LogoutRequest,
  UserDirectory,
} from '../src/identity-access/application/ports.ts';
import type { CompanyMembership, UserAccess } from '../src/identity-access/domain/access.ts';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { BlueprintFile } from '../src/blueprints/domain/blueprint.ts';
import type { ImageRegistry, PipelineHost } from '../src/builds/application/ports.ts';
import type { EmailMessage, Mailer } from '../src/notifications/application/ports.ts';
import {
  type CommitStatus,
  PermanentSourceError,
  type PullRequestSpec,
  type RepositorySpec,
  type SourceHost,
  type WebhookSpec,
} from '../src/source-governance/application/ports.ts';
import { TEAMS, type TeamKey } from '../src/source-governance/domain/git-flow.ts';
import {
  type GitOrganization,
  type GitProvider,
  PermanentProvisioningError,
} from '../src/tenancy/application/ports.ts';

export const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
export const COMPANY_B = '00000000-0000-4000-8000-00000000000b';

/**
 * People named nomfa-... sign in without a second factor unless the platform asks for one,
 * and nomfa-refuse-... never use one. Everyone else always does.
 */
const identity = (name: string, platformAdmin = false, mfaRequested = false): ExternalIdentity => ({
  subject: `fake|${name}`,
  email: `${name}@example.com`,
  emailVerified: true,
  displayName: name,
  platformAdmin,
  idToken: `id-token-of-${name}`,
  mfa: !name.startsWith('nomfa-') || (mfaRequested && !name.startsWith('nomfa-refuse-')),
});

/** Lets a test sign in as anyone by name. It never ships, because it lives in the tests. */
export class FakeIdentityProvider implements IdentityProvider {
  async authorizationUrl(request: AuthorizationRequest): Promise<string> {
    const url = new URL(request.redirectUri);
    // The hint is a name, or the email of one, as the step-up login sends.
    url.searchParams.set('code', (request.loginHint ?? '').replace(/@example\.com$/, ''));
    url.searchParams.set('state', request.state);
    if (request.requireMfa === true) {
      url.searchParams.set('mfa', '1');
    }
    return url.toString();
  }

  async exchangeCode(exchange: CodeExchange): Promise<ExternalIdentity | null> {
    const name = exchange.callbackUrl.searchParams.get('code') ?? '';
    if (!/^[a-z][a-z-]*$/.test(name) || name === 'constructor' || name.startsWith('unknown')) {
      return null;
    }
    return identity(name, name === 'platform-admin', exchange.callbackUrl.searchParams.get('mfa') === '1');
  }

  async logoutUrl(request: LogoutRequest): Promise<string | null> {
    return `http://login.test/logout?hint=${request.idToken ?? ''}&next=${encodeURIComponent(request.postLogoutRedirectUri)}`;
  }
}

const membership = (companyId: string, role: string, ...permissions: string[]): CompanyMembership => ({
  companyId,
  companyName: companyId === COMPANY_A ? 'Company A' : 'Company B',
  role,
  permissions,
});

const SAMPLE_MEMBERSHIPS: Readonly<Record<string, readonly CompanyMembership[]>> = {
  'tech-lead-a': [membership(COMPANY_A, 'tech-lead', 'applications:read', 'applications:write')],
  'developer-a': [membership(COMPANY_A, 'developer', 'applications:read')],
  'tech-lead-b': [membership(COMPANY_B, 'tech-lead', 'applications:read', 'applications:write')],
  'nomfa-tech-lead': [membership(COMPANY_A, 'tech-lead', 'applications:read', 'applications:write')],
  'nomfa-refuse-tech-lead': [membership(COMPANY_A, 'tech-lead', 'applications:read')],
  'nomfa-developer': [membership(COMPANY_A, 'developer', 'applications:read')],
  consultant: [
    membership(COMPANY_A, 'developer', 'applications:read'),
    membership(COMPANY_B, 'tech-lead', 'applications:read', 'applications:write'),
  ],
};

/** A fake UserDirectory for fast tests. The same contract tests run against this and PostgreSQL. */
export class InMemoryUserDirectory implements UserDirectory {
  readonly #users = new Map<string, UserAccess>();
  readonly #idsBySubject = new Map<string, string>();

  async recordLogin(external: ExternalIdentity): Promise<string> {
    const id = this.#idsBySubject.get(external.subject) ?? crypto.randomUUID();
    this.#idsBySubject.set(external.subject, id);
    const previous = this.#users.get(id);
    const name = external.subject.replace('fake|', '');
    this.#users.set(id, {
      userId: id,
      subject: external.subject,
      email: external.email,
      emailVerified: external.emailVerified,
      displayName: external.displayName,
      platformPermissions: external.platformAdmin ? ['audit:read-own', 'companies:manage', 'editions:manage'] : [],
      memberships: previous?.memberships ?? SAMPLE_MEMBERSHIPS[name] ?? [],
    });
    return id;
  }

  async loadAccess(userId: string): Promise<UserAccess | null> {
    return this.#users.get(userId) ?? null;
  }
}

/** Records organizations in memory, and can be told to fail. */
export class FakeGitProvider implements GitProvider {
  readonly organizations = new Map<string, GitOrganization>();
  /** Errors to throw, one per call, before calls start succeeding. */
  readonly failures: Error[] = [];
  calls = 0;

  async ensureOrganization(organization: GitOrganization): Promise<string> {
    this.calls += 1;
    const failure = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    const existing = this.organizations.get(organization.name);
    if (existing !== undefined && existing.companyId !== organization.companyId) {
      throw new PermanentProvisioningError(`The Git organization name "${organization.name}" is already taken.`);
    }
    this.organizations.set(organization.name, organization);
    return `org-${organization.name}`;
  }
}

/** Keeps sent emails in memory instead of sending them. */
export class FakeMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  failing = false;

  async send(message: EmailMessage): Promise<void> {
    if (this.failing) {
      throw new Error('Mail server unavailable');
    }
    this.sent.push(message);
  }
}

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
  readonly pullRequests: { number: number; head: string; base: string; title: string }[];
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

  async openPullRequest(spec: RepositorySpec, request: PullRequestSpec): Promise<number | null> {
    const repository = this.#repository(spec);
    const existing = repository.pullRequests.find((pull) => pull.head === request.head && pull.base === request.base);
    if (existing !== undefined) {
      return existing.number;
    }
    const number = repository.pullRequests.length + 1;
    repository.pullRequests.push({ number, head: request.head, base: request.base, title: request.title });
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

/** Keeps pushed images and signatures in memory. */
export class FakeImageRegistry implements ImageRegistry {
  readonly imageHost = 'registry.test';
  readonly images = new Map<string, string>();
  readonly signatures = new Map<string, { payload: Buffer; signature: string }>();
  readonly deleted: string[] = [];
  failing = false;

  async pushArchive(file: string, repository: string, tag: string): Promise<string> {
    if (this.failing) {
      throw new Error('The registry is unavailable.');
    }
    const digest = `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`;
    this.images.set(`${repository}:${tag}`, digest);
    return digest;
  }

  async pushSignature(repository: string, digest: string, payload: Buffer, signature: string): Promise<void> {
    this.signatures.set(`${repository}@${digest}`, { payload, signature });
  }

  async deleteTag(repository: string, tag: string): Promise<void> {
    this.images.delete(`${repository}:${tag}`);
    this.deleted.push(`${repository}:${tag}`);
  }
}

/** Records pipeline runs instead of starting them, so tests can play the jobs' part. */
export class FakePipelineHost implements PipelineHost {
  /** Each organization's workflows, by file name. */
  readonly pipelines = new Map<string, Readonly<Record<string, string>>>();
  readonly runs: { organization: string; workflow: string; inputs: Readonly<Record<string, string>> }[] = [];

  async ensurePipeline(organization: string, workflows: Readonly<Record<string, string>>): Promise<void> {
    this.pipelines.set(organization, workflows);
  }

  async run(organization: string, workflow: string, inputs: Readonly<Record<string, string>>): Promise<void> {
    this.runs.push({ organization, workflow, inputs });
  }

  /** The one-time token the platform gave a build's run. */
  tokenOf(buildId: string): string | undefined {
    return this.runs.find((run) => run.inputs.build === buildId)?.inputs.token;
  }
}
