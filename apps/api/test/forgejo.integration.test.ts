import { randomUUID } from 'node:crypto';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileScaffoldTemplates } from '../src/application-catalog/infrastructure/file-scaffold-templates.ts';
import { ProvisioningError } from '../src/tenancy/application/ports.ts';
import { ForgejoGitHosting } from '../src/tenancy/infrastructure/forgejo-git-hosting.ts';
import { describeGitHostingContract } from './git-hosting-contract.ts';

// The same image as the local stack.
const FORGEJO_IMAGE = 'codeberg.org/forgejo/forgejo:15.0.11';
// Forgejo keeps "admin" for itself.
const ADMIN_USERNAME = 'dreamdevops-admin';
const ADMIN_PASSWORD = 'fake-dummy-forgejo-admin-password';

let container: StartedTestContainer;
let url: string;

const asAdmin = (path: string, init: RequestInit = {}) =>
  fetch(`${url}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
  });

beforeAll(async () => {
  container = await new GenericContainer(FORGEJO_IMAGE)
    .withEnvironment({
      USER_UID: '1000',
      USER_GID: '1000',
      FORGEJO__database__DB_TYPE: 'sqlite3',
      FORGEJO__security__INSTALL_LOCK: 'true',
      FORGEJO__service__DISABLE_REGISTRATION: 'true',
    })
    .withExposedPorts(3000)
    .withWaitStrategy(Wait.forHttp('/api/healthz', 3000))
    .withStartupTimeout(180_000)
    .start();
  // As the local stack's forgejo-init service does.
  const created = await container.exec(
    [
      'forgejo',
      'admin',
      'user',
      'create',
      '--config',
      '/data/gitea/conf/app.ini',
      '--admin',
      '--username',
      ADMIN_USERNAME,
      '--password',
      ADMIN_PASSWORD,
      '--email',
      'dreamdevops-admin@example.com',
      '--must-change-password=false',
    ],
    { user: 'git' },
  );
  if (created.exitCode !== 0) {
    throw new Error(`Creating the Forgejo administrator failed: ${created.output}`);
  }
  url = `http://${container.getHost()}:${container.getMappedPort(3000)}`;
}, 240_000);

afterAll(async () => {
  await container?.stop();
});

describeGitHostingContract('Forgejo', () => ({
  hosting: new ForgejoGitHosting({ url, username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  addAccount: async (name) => {
    const response = await asAdmin('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: name,
        email: `${name}@example.com`,
        password: 'fake-dummy-user-password',
        must_change_password: false,
      }),
    });
    expect(response.status).toBe(201);
  },
  addRepository: async (organization, repository) => {
    const created = await asAdmin(`/orgs/${organization}/repos`, {
      method: 'POST',
      body: JSON.stringify({ name: repository, private: true, auto_init: true, default_branch: 'main' }),
    });
    expect(created.status).toBe(201);
    // A commit of their own, after Forgejo's first one.
    const committed = await asAdmin(`/repos/${organization}/${repository}/contents`, {
      method: 'POST',
      body: JSON.stringify({
        branch: 'main',
        message: 'Their own work',
        files: [{ operation: 'create', path: 'theirs.txt', content: Buffer.from('theirs\n').toString('base64') }],
      }),
    });
    expect(committed.status).toBe(201);
  },
  topicsOf: async (organization, repository) => {
    const response = await asAdmin(`/repos/${organization}/${repository}/topics`);
    return response.status === 404 ? null : ((await response.json()) as { topics: string[] }).topics;
  },
  fileOf: async (organization, repository, path) => {
    const response = await asAdmin(`/repos/${organization}/${repository}/raw/${path}`);
    return response.status === 404 ? null : response.text();
  },
  displayNameOf: async (name) => {
    const response = await asAdmin(`/orgs/${name}`);
    return response.status === 404 ? null : ((await response.json()) as { full_name: string }).full_name;
  },
}));

describe('Forgejo organizations', () => {
  it('are private, and record which company they belong to', async () => {
    const companyId = randomUUID();
    const hosting = new ForgejoGitHosting({ url, username: ADMIN_USERNAME, password: ADMIN_PASSWORD });

    await hosting.ensureOrganization({ name: 'private-check', displayName: 'Private Check', companyId });

    const organization = (await (await asAdmin('/orgs/private-check')).json()) as {
      visibility: string;
      description: string;
    };
    expect(organization.visibility).toBe('private');
    expect(organization.description).toContain(companyId);
  });

  it("take a whole scaffold in one commit, as an application's first files", async () => {
    const companyId = randomUUID();
    const hosting = new ForgejoGitHosting({ url, username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
    await hosting.ensureOrganization({ name: 'scaffold-check', displayName: 'Scaffold Check', companyId });
    await hosting.ensureRepository({
      organization: 'scaffold-check',
      name: 'orders-api',
      description: 'Takes orders.',
      topics: ['typescript-backend', 'nestjs'],
    });
    // The largest kind of scaffold, with its lockfile, in a single request.
    const files = await new FileScaffoldTemplates(['nestjs']).render('nestjs', {
      name: 'Orders "API"',
      slug: 'orders-api',
      description: 'Takes orders.',
    });

    await expect(
      hosting.addInitialFiles({ organization: 'scaffold-check', repository: 'orders-api', files, message: 'Start' }),
    ).resolves.toBe('added');

    const manifest = await (await asAdmin('/repos/scaffold-check/orders-api/raw/package.json')).json();
    expect(manifest).toMatchObject({ name: 'orders-api' });
    const commits = (await (await asAdmin('/repos/scaffold-check/orders-api/commits?sha=main')).json()) as unknown[];
    expect(commits).toHaveLength(2);
  });

  it('are refused with the wrong credentials, as something to fix rather than retry', async () => {
    const hosting = new ForgejoGitHosting({ url, username: ADMIN_USERNAME, password: 'wrong-password' });

    await expect(
      hosting.ensureOrganization({ name: 'wrong-login', displayName: 'Wrong', companyId: randomUUID() }),
    ).rejects.toBeInstanceOf(ProvisioningError);
  });
});
