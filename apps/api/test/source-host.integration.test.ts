import { fileURLToPath } from 'node:url';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlueprintLibrary } from '../src/blueprints/infrastructure/blueprint-library.ts';
import { PermanentSourceError, type RepositorySpec } from '../src/source-governance/application/ports.ts';
import { gunzipSync } from 'node:zlib';
import { GIT_FLOW, TESTS_CHECK, WEBHOOK_EVENTS } from '../src/source-governance/domain/git-flow.ts';
import { ForgejoSourceHost, ownershipMarker } from '../src/source-governance/infrastructure/forgejo-source-host.ts';
import { ForgejoGitProvider } from '../src/tenancy/infrastructure/forgejo-git-provider.ts';

const BOT = { username: 'test-bot', password: 'fake-dummy-bot-password' };
const ADMIN = { username: 'test-admin', password: 'fake-dummy-admin-password' };
const DEVELOPER = { username: 'dev-person', password: 'fake-dummy-dev-password' };
const LEAD = { username: 'lead-person', password: 'fake-dummy-lead-password' };
const COMPANY = '00000000-0000-4000-8000-0000000000c1';
const APPLICATION = '00000000-0000-4000-8000-0000000000a1';
const BLUEPRINTS = fileURLToPath(new URL('../../../blueprints', import.meta.url));

type User = { username: string; password: string };

describe('the Forgejo source adapter against a real Forgejo', () => {
  let forgejo: StartedTestContainer;
  let url: string;
  let host: ForgejoSourceHost;
  const spec: RepositorySpec = { organization: 'acme', name: 'billing-api', applicationId: APPLICATION };

  const api = (path: string, init: { method?: string; body?: object } = {}, user: User = ADMIN) =>
    fetch(`${url}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`${user.username}:${user.password}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });

  /** Writes a file the way a person would, through the API, and returns the status. */
  const writeFile = async (user: User, branch: string, path: string, newBranch?: string) =>
    (
      await api(
        '/repos/acme/billing-api/contents',
        {
          method: 'POST',
          body: {
            branch,
            ...(newBranch !== undefined && { new_branch: newBranch }),
            message: `Change ${path}`,
            files: [{ operation: 'create', path, content: Buffer.from('hello\n').toString('base64') }],
          },
        },
        user,
      )
    ).status;

  beforeAll(async () => {
    forgejo = await new GenericContainer('codeberg.org/forgejo/forgejo:15.0.11')
      .withEnvironment({
        FORGEJO__security__INSTALL_LOCK: 'true',
        FORGEJO__service__DISABLE_REGISTRATION: 'true',
        FORGEJO__service__DEFAULT_ALLOW_CREATE_ORGANIZATION: 'false',
      })
      .withExposedPorts(3000)
      .withWaitStrategy(Wait.forHttp('/api/healthz', 3000))
      .withStartupTimeout(120_000)
      .start();
    url = `http://${forgejo.getHost()}:${forgejo.getMappedPort(3000)}`;

    for (const [user, admin] of [
      [ADMIN, true],
      [BOT, false],
      [DEVELOPER, false],
      [LEAD, false],
    ] as const) {
      const result = await forgejo.exec(
        [
          'forgejo',
          'admin',
          'user',
          'create',
          '--config',
          '/data/gitea/conf/app.ini',
          ...(admin ? ['--admin'] : []),
          '--username',
          user.username,
          '--password',
          user.password,
          '--email',
          `${user.username}@example.com`,
          '--must-change-password=false',
        ],
        { user: 'git' },
      );
      if (result.exitCode !== 0) {
        throw new Error(`Creating ${user.username} failed: ${result.output}`);
      }
    }
    await api(`/admin/users/${BOT.username}`, {
      method: 'PATCH',
      body: { login_name: BOT.username, source_id: 0, allow_create_organization: true },
    });
    await new ForgejoGitProvider({ url, ...BOT }).ensureOrganization({
      name: 'acme',
      displayName: 'Acme',
      companyId: COMPANY,
    });
    host = new ForgejoSourceHost({ url, ...BOT });
  }, 180_000);

  afterAll(async () => {
    await forgejo?.stop();
  });

  it('creates the three teams, and repeating changes nothing', async () => {
    await host.ensureTeams('acme');
    await host.ensureTeams('acme');

    const teams = (await (await api('/orgs/acme/teams')).json()) as {
      name: string;
      includes_all_repositories: boolean;
      units_map: Record<string, string>;
    }[];
    const managed = teams.filter((team) => team.name !== 'Owners');
    expect(
      managed.map((team) => [team.name, team.units_map['repo.code'], team.units_map['repo.releases']]).sort(),
    ).toEqual([
      ['developers', 'write', 'read'],
      ['readers', 'read', 'read'],
      ['tech-leads', 'write', 'read'],
    ]);
    // Teams get each repository on its own, so the platform's pipeline repository stays out.
    expect(managed.every((team) => !team.includes_all_repositories)).toBe(true);
  });

  it('creates a private, empty repository marked as ours', async () => {
    const first = await host.ensureRepository(spec);
    const again = await host.ensureRepository(spec);

    expect(first).toEqual({ id: expect.any(String), empty: true });
    expect(again.id).toBe(first.id);
    const repository = (await (await api('/repos/acme/billing-api')).json()) as Record<string, unknown>;
    expect(repository).toMatchObject({ private: true, description: ownershipMarker(APPLICATION) });
  });

  it("refuses a repository that isn't ours", async () => {
    await api('/orgs/acme/repos', { method: 'POST', body: { name: 'taken', description: 'Someone else' } });

    await expect(host.ensureRepository({ ...spec, name: 'taken' })).rejects.toBeInstanceOf(PermanentSourceError);
  });

  it('commits the scaffold as the first commit on main', async () => {
    const files = BlueprintLibrary.load(BLUEPRINTS).render('node-service', '1.0.0', {
      name: 'Billing API',
      slug: 'billing-api',
    });

    await host.commitInitialFiles(spec, files, 'Scaffold from node-service 1.0.0');

    await expect(host.ensureRepository(spec)).resolves.toMatchObject({ empty: false });
    const response = await api('/repos/acme/billing-api/contents/package.json?ref=main');
    const content = Buffer.from(((await response.json()) as { content: string }).content, 'base64').toString();
    expect(JSON.parse(content).name).toBe('billing-api');
    const tree = (await (await api('/repos/acme/billing-api/git/trees/main?recursive=true&per_page=200')).json()) as {
      tree: { path: string }[];
    };
    expect(tree.tree.map((entry) => entry.path)).toEqual(expect.arrayContaining(files.map((file) => file.path)));
  });

  it('sets up Git Flow branches and rules, and repeating changes nothing', async () => {
    // Teams need access first: Forgejo drops approving teams that can't see the repository.
    await host.grantTeams(spec);
    await host.applyGitFlow(spec, GIT_FLOW);
    await host.applyGitFlow(spec, GIT_FLOW);

    const repository = (await (await api('/repos/acme/billing-api')).json()) as { default_branch: string };
    expect(repository.default_branch).toBe('develop');
    const rules = (await (await api('/repos/acme/billing-api/branch_protections')).json()) as {
      rule_name: string;
      required_approvals: number;
      approvals_whitelist_teams: string[];
      enable_status_check: boolean;
      status_check_contexts: string[];
    }[];
    const checks = Object.fromEntries(rules.map((rule) => [rule.rule_name, rule.status_check_contexts]));
    expect(checks).toEqual({
      main: [TESTS_CHECK, 'dreamdevops/rc-image'],
      develop: [TESTS_CHECK],
      'release/*': [TESTS_CHECK],
      'hotfix/*': [TESTS_CHECK],
    });
    expect(rules.map((rule) => rule.rule_name).sort()).toEqual(['develop', 'hotfix/*', 'main', 'release/*']);
    expect(rules.every((rule) => rule.required_approvals === 1)).toBe(true);
    expect(rules.every((rule) => rule.approvals_whitelist_teams.includes('tech-leads'))).toBe(true);
    const tags = (await (await api('/repos/acme/billing-api/tag_protections')).json()) as { name_pattern: string }[];
    expect(tags.map((tag) => tag.name_pattern)).toEqual(['v*']);
  });

  it('gives the teams access to the repository', async () => {
    await host.grantTeams(spec);
    await host.grantTeams(spec);

    const teams = (await (await api('/orgs/acme/teams')).json()) as { id: number; name: string }[];
    for (const team of teams.filter((candidate) => candidate.name !== 'Owners')) {
      const repositories = (await (await api(`/teams/${team.id}/repos`)).json()) as { name: string }[];
      expect(repositories.map((repository) => repository.name)).toEqual(['billing-api']);
    }
  });

  it('sends events to one webhook, and repeating changes nothing', async () => {
    const hook = { url: 'http://host.docker.internal:4000/api/v1/webhooks/forgejo', secret: 'a'.repeat(64), events: WEBHOOK_EVENTS };
    await host.ensureWebhook(spec, hook);
    await host.ensureWebhook(spec, { ...hook, secret: 'b'.repeat(64) });

    const hooks = (await (await api('/repos/acme/billing-api/hooks')).json()) as {
      config: { url: string; content_type: string };
      events: string[];
      active: boolean;
    }[];
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ active: true, config: { url: hook.url, content_type: 'json' } });
    // Forgejo lists each event with its finer parts, such as pull_request_review.
    expect(hooks[0]!.events).toEqual(expect.arrayContaining([...WEBHOOK_EVENTS]));
  });

  it('reads and creates branches and tags, and opens pull requests once', async () => {
    const develop = await host.branchHead(spec, 'develop');
    expect(develop).toMatch(/^[0-9a-f]{40}$/);
    await expect(host.branchHead(spec, 'missing')).resolves.toBeNull();
    await expect(host.createBranch(spec, 'release/0.0.9', 'develop')).resolves.toBe(develop);
    await expect(host.createBranch(spec, 'release/0.0.9', 'develop')).resolves.toBe(develop);
    expect(await host.listBranches(spec)).toEqual(expect.arrayContaining(['develop', 'main', 'release/0.0.9']));

    await host.createTag(spec, 'v0.0.9-rc.1', develop!);
    await host.createTag(spec, 'v0.0.9-rc.1', develop!);
    const main = await host.branchHead(spec, 'main');
    if (main !== develop) {
      await expect(host.createTag(spec, 'v0.0.9-rc.1', main!)).rejects.toBeInstanceOf(PermanentSourceError);
    }
    // develop and main hold the same commits, so there's nothing to merge.
    await expect(host.openPullRequest(spec, { head: 'develop', base: 'main', title: 'Nothing', body: '' })).resolves.toBeNull();

    const archive = gunzipSync(Buffer.from(await new Response(await host.downloadArchive(spec, develop!)).arrayBuffer()));
    expect(archive.toString('latin1')).toContain('billing-api/package.json');

    // One file at a commit, such as the Dockerfile the platform checks before a build.
    expect((await host.readFile(spec, develop!, 'Dockerfile'))?.toString()).toContain('FROM ');
    await expect(host.readFile(spec, develop!, 'missing/file.txt')).resolves.toBeNull();
  });

  it('puts people in teams, and reports who has an account', async () => {
    await host.addTeamMember('acme', 'developers', DEVELOPER.username);
    await host.addTeamMember('acme', 'tech-leads', LEAD.username);
    await host.addTeamMember('acme', 'readers', LEAD.username);
    await host.removeTeamMember('acme', 'readers', LEAD.username);
    await host.removeTeamMember('acme', 'readers', LEAD.username);

    await expect(host.teamMembers('acme', 'developers')).resolves.toEqual([DEVELOPER.username]);
    await expect(host.teamMembers('acme', 'tech-leads')).resolves.toEqual([LEAD.username]);
    await expect(host.teamMembers('acme', 'readers')).resolves.toEqual([]);
    await expect(host.userExists(DEVELOPER.username)).resolves.toBe(true);
    await expect(host.userExists('nobody-here')).resolves.toBe(false);
  });

  it('lets developers push to feature branches, but never directly to develop or main', async () => {
    expect(await writeFile(DEVELOPER, 'develop', 'feature.txt', 'feature/greeting')).toBe(201);
    expect(await writeFile(DEVELOPER, 'develop', 'direct.txt')).toBeGreaterThanOrEqual(400);
    expect(await writeFile(DEVELOPER, 'main', 'direct.txt')).toBeGreaterThanOrEqual(400);
    expect(await writeFile(LEAD, 'develop', 'direct.txt')).toBeGreaterThanOrEqual(400);
  });

  it('keeps release branches and version tags for the platform', async () => {
    const tag = (user: User, name: string) =>
      api('/repos/acme/billing-api/tags', { method: 'POST', body: { tag_name: name, target: 'main' } }, user);
    const branch = (user: User, name: string) =>
      api('/repos/acme/billing-api/branches', { method: 'POST', body: { new_branch_name: name, old_ref_name: 'develop' } }, user);

    expect((await tag(LEAD, 'v1.0.0')).status).toBeGreaterThanOrEqual(400);
    expect((await branch(LEAD, 'release/1.0.0')).status).toBeGreaterThanOrEqual(400);
    expect((await tag(BOT, 'v0.1.0')).status).toBe(201);
    expect((await branch(BOT, 'release/0.1.0')).status).toBe(201);
  });

  it('merges a pull request into develop only after a Tech Lead approves it', async () => {
    const { number } = (await (
      await api(
        '/repos/acme/billing-api/pulls',
        { method: 'POST', body: { head: 'feature/greeting', base: 'develop', title: 'Add a greeting' } },
        DEVELOPER,
      )
    ).json()) as { number: number };
    const merge = () =>
      api(`/repos/acme/billing-api/pulls/${number}/merge`, { method: 'POST', body: { Do: 'merge' } }, DEVELOPER);

    expect((await merge()).status).toBeGreaterThanOrEqual(400);

    const review = await api(
      `/repos/acme/billing-api/pulls/${number}/reviews`,
      { method: 'POST', body: { event: 'APPROVED', body: 'Looks good' } },
      LEAD,
    );
    expect(review.status).toBe(200);
    // Approved, but the tests haven't passed yet.
    expect((await merge()).status).toBeGreaterThanOrEqual(400);

    const pull = (await (await api(`/repos/acme/billing-api/pulls/${number}`)).json()) as { head: { sha: string } };
    await expect(host.findPullRequest(spec, 'feature/greeting', 'develop')).resolves.toEqual({
      number,
      merged: false,
      mergeCommit: null,
    });
    await host.setCommitStatus(spec, pull.head.sha, { context: TESTS_CHECK, state: 'success', description: 'Passed' });
    expect((await merge()).status).toBe(200);

    // A merge the platform missed can be found later, with its merge commit.
    const merged = await host.findPullRequest(spec, 'feature/greeting', 'develop');
    expect(merged).toMatchObject({ number, merged: true });
    expect(merged!.mergeCommit).toBe(await host.branchHead(spec, 'develop'));
    await expect(host.findPullRequest(spec, 'feature/none', 'develop')).resolves.toBeNull();
  });

  it('archives and restores the repository', async () => {
    await host.setArchived(spec, true);
    expect(((await (await api('/repos/acme/billing-api')).json()) as { archived: boolean }).archived).toBe(true);

    await host.setArchived(spec, false);
    expect(((await (await api('/repos/acme/billing-api')).json()) as { archived: boolean }).archived).toBe(false);
  });
});
