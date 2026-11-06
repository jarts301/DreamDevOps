import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermanentProvisioningError } from '../src/tenancy/application/ports.ts';
import { ForgejoGitProvider, ownershipMarker } from '../src/tenancy/infrastructure/forgejo-git-provider.ts';

const BOT = { username: 'test-bot', password: 'fake-dummy-bot-password' };
const ADMIN = { username: 'test-admin', password: 'fake-dummy-admin-password' };
const COMPANY = '00000000-0000-4000-8000-0000000000c1';
const OTHER_COMPANY = '00000000-0000-4000-8000-0000000000c2';

describe('the Forgejo adapter against a real Forgejo', () => {
  let forgejo: StartedTestContainer;
  let url: string;
  let provider: ForgejoGitProvider;

  const api = (path: string, init: RequestInit = {}, user = ADMIN) =>
    fetch(`${url}/api/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${user.username}:${user.password}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
    });

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

    const create = (user: { username: string; password: string }, admin: boolean) =>
      forgejo.exec(
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
    for (const [user, admin] of [
      [ADMIN, true],
      [BOT, false],
    ] as const) {
      const result = await create(user, admin);
      if (result.exitCode !== 0) {
        throw new Error(`Creating ${user.username} failed: ${result.output}`);
      }
    }
    const allowed = await api(`/admin/users/${BOT.username}`, {
      method: 'PATCH',
      body: JSON.stringify({ login_name: BOT.username, source_id: 0, allow_create_organization: true }),
    });
    expect(allowed.ok).toBe(true);

    provider = new ForgejoGitProvider({ url, ...BOT });
  }, 180_000);

  afterAll(async () => {
    await forgejo?.stop();
  });

  it('creates a private organization owned by the bot', async () => {
    const id = await provider.ensureOrganization({ name: 'acme', displayName: 'Acme Inc.', companyId: COMPANY });

    const response = await api('/orgs/acme');
    const organization = (await response.json()) as Record<string, unknown>;
    expect(String(organization.id)).toBe(id);
    expect(organization).toMatchObject({
      full_name: 'Acme Inc.',
      visibility: 'private',
      description: ownershipMarker(COMPANY),
    });
    const members = (await (await api('/orgs/acme/members')).json()) as { login: string }[];
    expect(members.map((member) => member.login)).toEqual([BOT.username]);
  });

  it('is safe to repeat', async () => {
    const first = await provider.ensureOrganization({ name: 'repeat', displayName: 'Repeat', companyId: COMPANY });

    const second = await provider.ensureOrganization({ name: 'repeat', displayName: 'Repeat', companyId: COMPANY });

    expect(second).toBe(first);
  });

  it('updates the display name after a rename', async () => {
    await provider.ensureOrganization({ name: 'renamed', displayName: 'Old Name', companyId: COMPANY });

    await provider.ensureOrganization({ name: 'renamed', displayName: 'New Name', companyId: COMPANY });

    const organization = (await (await api('/orgs/renamed')).json()) as { full_name: string };
    expect(organization.full_name).toBe('New Name');
  });

  it("refuses to touch another company's organization", async () => {
    await provider.ensureOrganization({ name: 'owned', displayName: 'Owned', companyId: COMPANY });

    await expect(
      provider.ensureOrganization({ name: 'owned', displayName: 'Hijack', companyId: OTHER_COMPANY }),
    ).rejects.toBeInstanceOf(PermanentProvisioningError);
    const organization = (await (await api('/orgs/owned')).json()) as { full_name: string };
    expect(organization.full_name).toBe('Owned');
  });

  it('refuses a name already used by a person', async () => {
    await expect(
      provider.ensureOrganization({ name: ADMIN.username, displayName: 'Clash', companyId: COMPANY }),
    ).rejects.toBeInstanceOf(PermanentProvisioningError);
  });

  it('refuses wrong credentials without retrying forever', async () => {
    const wrong = new ForgejoGitProvider({ url, username: BOT.username, password: 'wrong-password' });

    await expect(
      wrong.ensureOrganization({ name: 'never', displayName: 'Never', companyId: COMPANY }),
    ).rejects.toBeInstanceOf(PermanentProvisioningError);
  });

  it('reports an unreachable service as a passing failure', async () => {
    const offline = new ForgejoGitProvider({ url: 'http://127.0.0.1:1', ...BOT, timeoutMs: 2_000 });

    const failure = await offline
      .ensureOrganization({ name: 'never', displayName: 'Never', companyId: COMPANY })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PermanentProvisioningError);
  });

  it('keeps ordinary users from creating organizations', async () => {
    const response = await api('/orgs', {
      method: 'POST',
      body: JSON.stringify({ username: 'rogue' }),
    }, BOT);
    expect(response.ok).toBe(true);
    const created = await forgejo.exec(
      ['forgejo', 'admin', 'user', 'create', '--config', '/data/gitea/conf/app.ini', '--username', 'plain-user',
        '--password', 'fake-dummy-plain-password', '--email', 'plain@example.com', '--must-change-password=false'],
      { user: 'git' },
    );
    expect(created.exitCode).toBe(0);

    const refused = await api(
      '/orgs',
      { method: 'POST', body: JSON.stringify({ username: 'not-allowed' }) },
      { username: 'plain-user', password: 'fake-dummy-plain-password' },
    );

    expect(refused.status).toBe(403);
  });
});
