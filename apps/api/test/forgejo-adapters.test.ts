import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PermanentSourceError } from '../src/source-governance/application/ports.ts';
import { GIT_FLOW } from '../src/source-governance/domain/git-flow.ts';
import {
  ForgejoSourceHost,
  ownershipMarker as repositoryMarker,
} from '../src/source-governance/infrastructure/forgejo-source-host.ts';
import { PermanentProvisioningError } from '../src/tenancy/application/ports.ts';
import { ForgejoGitProvider, ownershipMarker as organizationMarker } from '../src/tenancy/infrastructure/forgejo-git-provider.ts';
import { HttpStub } from './support/http-stub.ts';

/**
 * Fast checks of the Forgejo adapters' HTTP behavior, with no Docker. The
 * forgejo and source-host integration tests check the same adapters against a real Forgejo.
 */
const forgejo = new HttpStub();
const BOT = { username: 'bot', password: 'fake-dummy-password' };
const COMPANY = '00000000-0000-4000-8000-0000000000c1';
const APPLICATION = '00000000-0000-4000-8000-0000000000a1';
const SPEC = { organization: 'acme', name: 'billing', applicationId: APPLICATION };

beforeAll(async () => {
  await forgejo.start();
});
afterAll(() => forgejo.stop());
beforeEach(() => forgejo.reset());

describe('the Forgejo organization adapter', () => {
  const provider = () => new ForgejoGitProvider({ url: `${forgejo.url}/`, ...BOT });
  const organization = { name: 'acme', displayName: 'Acme', companyId: COMPANY };

  it('creates a private organization, marked as the company’s, signing in as the bot', async () => {
    forgejo.on('POST', '/api/v1/orgs', { status: 201, body: { id: 7 } });

    expect(await provider().ensureOrganization(organization)).toBe('7');

    expect(forgejo.calls()).toEqual(['GET /api/v1/orgs/acme', 'POST /api/v1/orgs']);
    expect(forgejo.requests[1]!.body).toEqual({
      username: 'acme',
      full_name: 'Acme',
      description: organizationMarker(COMPANY),
      visibility: 'private',
      repo_admin_change_team_access: false,
    });
    expect(forgejo.requests[0]!.headers.authorization).toBe(`Basic ${Buffer.from('bot:fake-dummy-password').toString('base64')}`);
  });

  it('brings its own organization up to date, and leaves it alone when nothing changed', async () => {
    const current = { id: 7, full_name: 'Old name', description: organizationMarker(COMPANY), visibility: 'public' };
    forgejo.on('GET', '/api/v1/orgs/acme', { body: current }).on('PATCH', '/api/v1/orgs/acme', { body: {} });

    expect(await provider().ensureOrganization(organization)).toBe('7');
    expect(forgejo.requests.at(-1)!.body).toEqual({ full_name: 'Acme', visibility: 'private' });

    forgejo.reset();
    forgejo.on('GET', '/api/v1/orgs/acme', { body: { ...current, full_name: 'Acme', visibility: 'private' } });
    await provider().ensureOrganization(organization);
    expect(forgejo.calls()).toEqual(['GET /api/v1/orgs/acme']);
  });

  it('refuses, for good, a name someone else already has', async () => {
    forgejo.on('POST', '/api/v1/orgs', { status: 422 });
    await expect(provider().ensureOrganization(organization)).rejects.toThrow(
      new PermanentProvisioningError('The Git organization name "acme" is already taken.'),
    );

    forgejo.on('GET', '/api/v1/orgs/acme', { body: { id: 8, description: 'Someone else’s', full_name: 'Acme', visibility: 'private' } });
    await expect(provider().ensureOrganization(organization)).rejects.toThrow(
      'A Git organization named "acme" exists but belongs to someone else.',
    );
  });

  it('treats refused credentials as permanent, and server errors and outages as temporary', async () => {
    forgejo.on('GET', '/api/v1/orgs/acme', { status: 401 });
    const refused = await provider().ensureOrganization(organization).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PermanentProvisioningError);
    expect((refused as Error).message).toBe("The Git service refused the platform's credentials to read the Git organization.");

    forgejo.on('GET', '/api/v1/orgs/acme', { status: 502 });
    const failed = await provider().ensureOrganization(organization).catch((error: unknown) => error);
    expect(failed).not.toBeInstanceOf(PermanentProvisioningError);
    expect((failed as Error).message).toBe('The Git service could not read the Git organization (status 502).');

    const unreachable = new ForgejoGitProvider({ url: 'http://127.0.0.1:1', ...BOT });
    await expect(unreachable.ensureOrganization(organization)).rejects.toThrow('The Git service could not be reached.');
  });
});

describe('the Forgejo repository adapter', () => {
  const host = () => new ForgejoSourceHost({ url: forgejo.url, ...BOT });
  const ours = { id: 5, description: repositoryMarker(APPLICATION), empty: true, archived: false, default_branch: 'main' };

  it('creates the three teams, or updates them, with read-only releases, actions and packages', async () => {
    forgejo
      .on('GET', '/api/v1/orgs/acme/teams?limit=50', { body: [{ id: 3, name: 'readers' }] })
      .on('POST', '/api/v1/orgs/acme/teams', { status: 201, body: {} })
      .on('PATCH', '/api/v1/teams/3', { body: {} });

    await host().ensureTeams('acme');

    expect(forgejo.calls().slice(1)).toEqual([
      'POST /api/v1/orgs/acme/teams',
      'POST /api/v1/orgs/acme/teams',
      'PATCH /api/v1/teams/3',
    ]);
    expect(forgejo.requests[1]!.body).toMatchObject({
      name: 'tech-leads',
      permission: 'write',
      // Each repository is added on its own, so the platform's pipeline repository stays out.
      includes_all_repositories: false,
      can_create_org_repo: false,
      units_map: { 'repo.code': 'write', 'repo.releases': 'read', 'repo.actions': 'read', 'repo.packages': 'read' },
    });
    expect(forgejo.requests[3]!.body).toMatchObject({ name: 'readers', permission: 'read' });
  });

  it('creates a private, empty repository marked as the application’s, or reuses its own', async () => {
    let created = false;
    forgejo
      .on('GET', '/api/v1/repos/acme/billing', () => (created ? { body: ours } : { status: 404 }))
      .on('POST', '/api/v1/orgs/acme/repos', () => {
        created = true;
        return { status: 201, body: {} };
      });

    expect(await host().ensureRepository(SPEC)).toEqual({ id: '5', empty: true });
    expect(forgejo.requests[1]!.body).toEqual({
      name: 'billing',
      description: repositoryMarker(APPLICATION),
      private: true,
      auto_init: false,
      default_branch: 'main',
    });

    forgejo.reset();
    forgejo.on('GET', '/api/v1/repos/acme/billing', { body: { ...ours, empty: false } });
    expect(await host().ensureRepository(SPEC)).toEqual({ id: '5', empty: false });
  });

  it('refuses, for good, a repository that belongs to something else', async () => {
    forgejo.on('GET', '/api/v1/repos/acme/billing', { body: { ...ours, description: 'Hand-made' } });

    await expect(host().ensureRepository(SPEC)).rejects.toThrow(
      new PermanentSourceError('A repository named "billing" exists but belongs to something else.'),
    );
  });

  it('commits the scaffold as one commit on main', async () => {
    forgejo.on('POST', '/api/v1/repos/acme/billing/contents', { status: 201, body: {} });

    await host().commitInitialFiles(SPEC, [{ path: 'README.md', content: Buffer.from('# Billing') }], 'Start');

    expect(forgejo.requests[0]!.body).toEqual({
      branch: 'main',
      message: 'Start',
      files: [{ operation: 'create', path: 'README.md', content: Buffer.from('# Billing').toString('base64') }],
    });
  });

  it('applies Git Flow: develop as default, branch rules for the platform, and platform-only version tags', async () => {
    forgejo
      .on('POST', '/api/v1/repos/acme/billing/branches', { status: 409 })
      .on('PATCH', '/api/v1/repos/acme/billing', { body: {} })
      .on('GET', '/api/v1/repos/acme/billing/branch_protections', { body: [{ rule_name: 'main' }] })
      .on('POST', '/api/v1/repos/acme/billing/branch_protections', { status: 201, body: {} })
      .on('PATCH', /^\/api\/v1\/repos\/acme\/billing\/branch_protections\//, { body: {} })
      .on('GET', '/api/v1/repos/acme/billing/tag_protections', { body: [] })
      .on('POST', '/api/v1/repos/acme/billing/tag_protections', { status: 201, body: {} });

    await host().applyGitFlow(SPEC, GIT_FLOW);

    expect(forgejo.calls()).toEqual([
      'POST /api/v1/repos/acme/billing/branches',
      'PATCH /api/v1/repos/acme/billing',
      'GET /api/v1/repos/acme/billing/branch_protections',
      'PATCH /api/v1/repos/acme/billing/branch_protections/main',
      'POST /api/v1/repos/acme/billing/branch_protections',
      'POST /api/v1/repos/acme/billing/branch_protections',
      'POST /api/v1/repos/acme/billing/branch_protections',
      'GET /api/v1/repos/acme/billing/tag_protections',
      'POST /api/v1/repos/acme/billing/tag_protections',
    ]);
    expect(forgejo.requests[1]!.body).toEqual({ default_branch: 'develop' });
    const release = forgejo.requests.find((request) => (request.body as { rule_name?: string })?.rule_name === 'release/*')!;
    expect(release.body).toMatchObject({
      enable_push: true,
      enable_push_whitelist: true,
      push_whitelist_usernames: ['bot'],
      required_approvals: 1,
      approvals_whitelist_teams: ['tech-leads'],
      block_on_rejected_reviews: true,
      dismiss_stale_approvals: true,
      apply_to_admins: true,
    });
    expect(forgejo.requests[3]!.body).toMatchObject({ rule_name: 'main', enable_push: false, push_whitelist_usernames: [] });
    expect(forgejo.requests.at(-1)!.body).toEqual({ name_pattern: 'v*', whitelist_usernames: ['bot'], whitelist_teams: [] });
  });

  it('archives and restores, ignoring a repository that is gone', async () => {
    forgejo.on('PATCH', '/api/v1/repos/acme/billing', { body: {} });
    await host().setArchived(SPEC, true);
    expect(forgejo.requests[0]!.body).toEqual({ archived: true });

    forgejo.on('PATCH', '/api/v1/repos/acme/billing', { status: 404 });
    await expect(host().setArchived(SPEC, false)).resolves.toBeUndefined();
  });

  it('finds people and team members, page by page', async () => {
    forgejo
      .on('GET', '/api/v1/users/known', { body: { login: 'known' } })
      .on('GET', '/api/v1/orgs/acme/teams?limit=50', { body: [{ id: 4, name: 'developers' }] })
      .on('GET', /^\/api\/v1\/teams\/4\/members\?limit=50&page=1$/, {
        body: Array.from({ length: 50 }, (_, index) => ({ login: `person-${index}` })),
      })
      .on('GET', /^\/api\/v1\/teams\/4\/members\?limit=50&page=2$/, { body: [{ login: 'last' }] });

    expect(await host().userExists('known')).toBe(true);
    expect(await host().userExists('unknown')).toBe(false);
    const members = await host().teamMembers('acme', 'developers');
    expect(members).toHaveLength(51);
    expect(members.at(-1)).toBe('last');
    expect(await host().teamMembers('acme', 'readers')).toEqual([]);
  });

  it('adds and removes team members, ignoring someone already gone', async () => {
    forgejo
      .on('GET', '/api/v1/orgs/acme/teams?limit=50', { body: [{ id: 4, name: 'developers' }] })
      .on('PUT', '/api/v1/teams/4/members/dev-1', { status: 204 })
      .on('DELETE', '/api/v1/teams/4/members/dev-1', { status: 404 });

    await host().addTeamMember('acme', 'developers', 'dev-1');
    await host().removeTeamMember('acme', 'developers', 'dev-1');

    expect(forgejo.calls()).toContain('PUT /api/v1/teams/4/members/dev-1');
    await expect(host().addTeamMember('acme', 'readers', 'dev-1')).rejects.toThrow("The readers team doesn't exist yet.");
  });

  it('treats refused credentials as permanent, and server errors and outages as temporary', async () => {
    forgejo.on('GET', '/api/v1/repos/acme/billing', { status: 403 });
    const refused = await host().ensureRepository(SPEC).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PermanentSourceError);
    expect((refused as Error).message).toBe("The Git service refused the platform's credentials to read the repository.");

    forgejo.on('GET', '/api/v1/repos/acme/billing', { status: 500 });
    const failed = await host().ensureRepository(SPEC).catch((error: unknown) => error);
    expect(failed).not.toBeInstanceOf(PermanentSourceError);
    expect((failed as Error).message).toBe('The Git service could not read the repository (status 500).');

    const unreachable = new ForgejoSourceHost({ url: 'http://127.0.0.1:1', ...BOT });
    await expect(unreachable.userExists('someone')).rejects.toThrow('The Git service could not be reached.');
  });
});
