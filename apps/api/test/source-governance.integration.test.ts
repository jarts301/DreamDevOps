import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IDENTITY_PROVIDER } from '../src/identity-access/application/ports.ts';
import { PermanentSourceError, SOURCE_HOST } from '../src/source-governance/application/ports.ts';
import { GIT_PROVIDER } from '../src/tenancy/application/ports.ts';
import { FakeGitProvider, FakeIdentityProvider, FakeSourceHost } from './fakes.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';
import { type Agent, eventually as waitUntil, signIn as signInAs, unique } from './support/integration.ts';

let database: TestDatabase;
let ownerPool: pg.Pool;
let app: INestApplication;
const host = new FakeSourceHost();

const eventually = (assertion: () => Promise<void> | void) => waitUntil(assertion);

const signIn = (user: string) => signInAs(app, user);

/** The fake login gives each person this subject, which is also their Git username. */
const gitUser = (name: string) => `fake|${name}`;

const createCompany = async () => {
  const platformAdmin = await signIn('platform-admin');
  const adminName = unique('admin');
  const { body } = await platformAdmin
    .post('/api/v1/platform/companies')
    .send({ name: unique('Company'), firstAdminEmail: `${adminName}@example.com` })
    .expect(201);
  const admin = await signIn(adminName);
  await admin.post('/api/v1/invitations/accept').send({ token: body.invitation.token }).expect(200);
  // Repositories need the company's Git organization, which is set up in the background.
  await eventually(async () => {
    const { rows } = await ownerPool.query('SELECT status FROM tenancy.companies WHERE id = $1', [body.company.id]);
    expect(rows[0].status).toBe('active');
  });
  return {
    platformAdmin,
    admin,
    adminName,
    companyId: body.company.id as string,
    organization: body.company.slug as string,
  };
};

const addMember = async (admin: Agent, role: string) => {
  const name = unique(role);
  const { body } = await admin
    .post('/api/v1/company/invitations')
    .send({ email: `${name}@example.com`, role })
    .expect(201);
  const agent = await signIn(name);
  await agent.post('/api/v1/invitations/accept').send({ token: body.token }).expect(200);
  const me = await agent.get('/api/v1/auth/me').expect(200);
  return { agent, name, userId: me.body.userId as string };
};

const register = async (agent: Agent, name: string, type = 'restful-service') =>
  (await agent.post('/api/v1/company/applications').send({ name, type }).expect(201)).body as {
    id: string;
    slug: string;
  };

const repositoryOf = async (agent: Agent, applicationId: string) => {
  const { body } = await agent.get('/api/v1/company/repositories').expect(200);
  return (body as { applicationId: string }[]).find((repository) => repository.applicationId === applicationId) as
    | {
        status: string;
        fullName: string;
        url: string;
        blueprint: { key: string; version: string } | null;
        lastError: string | null;
      }
    | undefined;
};

const auditTypes = async (admin: Agent) =>
  ((await admin.get('/api/v1/company/audit').expect(200)).body.entries as { eventType: string }[]).map(
    (entry) => entry.eventType,
  );

beforeAll(async () => {
  database = await startTestDatabase();
  ownerPool = new pg.Pool({ connectionString: database.urlFor('owner') });
  app = await buildApp({
    background: true,
    config: {
      databaseUrl: database.urlFor('app'),
      relayDatabaseUrl: database.urlFor('relay'),
      jobsDatabaseUrl: database.urlFor('jobs'),
      secureCookies: false,
      provisioningMaxAttempts: 3,
      provisioningRetrySeconds: 1,
    },
    overrides: [
      { provide: IDENTITY_PROVIDER, useValue: new FakeIdentityProvider() },
      { provide: GIT_PROVIDER, useValue: new FakeGitProvider() },
      { provide: SOURCE_HOST, useValue: host },
    ],
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await ownerPool?.end();
  await database?.stop();
});

beforeEach(() => {
  host.failures.length = 0;
});

describe('application types', () => {
  it('show the blueprint each type starts from', async () => {
    const { admin } = await createCompany();

    const { body } = await admin.get('/api/v1/company/application-types').expect(200);

    expect(body).toEqual([
      expect.objectContaining({
        key: 'restful-service',
        blueprint: expect.objectContaining({ key: 'node-service', version: '1.2.0', language: 'TypeScript' }),
      }),
      expect.objectContaining({
        key: 'web-frontend',
        blueprint: expect.objectContaining({ key: 'angular-frontend', version: '1.2.0' }),
      }),
    ]);
  });

  it('leave out a type with no blueprint, and refuse to register it', async () => {
    const { admin } = await createCompany();
    await ownerPool.query(
      "INSERT INTO catalog.application_types (key, name, description) VALUES ('mobile-app', 'Mobile App', 'Phones') ON CONFLICT DO NOTHING",
    );

    const { body } = await admin.get('/api/v1/company/application-types').expect(200);

    expect(body.map((type: { key: string }) => type.key)).not.toContain('mobile-app');
    await admin.post('/api/v1/company/applications').send({ name: 'Phone', type: 'mobile-app' }).expect(400);
  });
});

describe('the blueprint library', () => {
  it('lists every version for any signed-in user', async () => {
    const { admin } = await createCompany();

    const { body } = await admin.get('/api/v1/blueprints').expect(200);

    expect(body.map((blueprint: { key: string; version: string }) => `${blueprint.key}@${blueprint.version}`)).toEqual([
      'angular-frontend@1.2.0',
      'angular-frontend@1.1.0',
      'angular-frontend@1.0.0',
      'node-service@1.2.0',
      'node-service@1.1.0',
      'node-service@1.0.0',
    ]);
  });
});

describe('registering an application', () => {
  it('creates its repository from the blueprint, with Git Flow, in the background', async () => {
    const { admin, organization } = await createCompany();

    const application = await register(admin, 'Billing API');

    await eventually(async () => expect((await repositoryOf(admin, application.id))?.status).toBe('ready'));
    const repository = await repositoryOf(admin, application.id);
    expect(repository).toEqual({
      applicationId: application.id,
      status: 'ready',
      fullName: `${organization}/billing-api`,
      url: `http://git.test/${organization}/billing-api`,
      blueprint: { key: 'node-service', version: '1.2.0' },
      lastError: null,
    });
    const stored = host.repositories.get(`${organization}/billing-api`)!;
    expect(stored.gitFlow).toBe(true);
    const packageJson = stored.files.find((file) => file.path === 'package.json')!;
    expect(JSON.parse(packageJson.content.toString()).name).toBe('billing-api');
    await eventually(async () => expect(await auditTypes(admin)).toContain('RepositoryCreated'));
  });

  it('uses the blueprint of the chosen type', async () => {
    const { admin, organization } = await createCompany();

    const application = await register(admin, 'Storefront', 'web-frontend');

    await eventually(async () => expect((await repositoryOf(admin, application.id))?.status).toBe('ready'));
    const files = host.repositories.get(`${organization}/storefront`)!.files;
    expect(files.find((file) => file.path === 'src/app/app-info.ts')!.content.toString()).toContain('"Storefront"');
  });

  it('tries again after a temporary failure', async () => {
    const { admin } = await createCompany();
    host.failures.push(new Error('The Git service could not be reached.'));

    const application = await register(admin, 'Retried');

    await eventually(async () => expect((await repositoryOf(admin, application.id))?.status).toBe('ready'));
    expect((await repositoryOf(admin, application.id))?.lastError).toBeNull();
  });

  it('gives up on a permanent failure, says why, and can be tried again', async () => {
    const { admin } = await createCompany();
    host.failures.push(new PermanentSourceError('A repository named "clash" exists but belongs to something else.'));

    const application = await register(admin, 'Clash');

    await eventually(async () => expect((await repositoryOf(admin, application.id))?.status).toBe('failed'));
    expect((await repositoryOf(admin, application.id))?.lastError).toContain('belongs to something else');
    await eventually(async () => expect(await auditTypes(admin)).toContain('RepositoryCreationFailed'));

    await admin.post(`/api/v1/company/applications/${application.id}/repository`).expect(202);

    await eventually(async () => expect((await repositoryOf(admin, application.id))?.status).toBe('ready'));
    await admin.post(`/api/v1/company/applications/${application.id}/repository`).expect(409);
  });

  it('lets only Tech Leads and Company Admins ask for a repository', async () => {
    const { admin } = await createCompany();
    const developer = await addMember(admin, 'developer');
    const application = await register(admin, 'Guarded');

    await developer.agent.post(`/api/v1/company/applications/${application.id}/repository`).expect(403);
    await developer.agent.get('/api/v1/company/repositories').expect(200);
  });
});

describe('archiving an application', () => {
  it('makes its repository read-only, and restoring undoes it', async () => {
    const { admin, organization } = await createCompany();
    const application = await register(admin, 'Old Service');
    await eventually(async () => expect((await repositoryOf(admin, application.id))?.status).toBe('ready'));

    await admin.post(`/api/v1/company/applications/${application.id}/archive`).expect(204);
    await eventually(() => expect(host.repositories.get(`${organization}/old-service`)!.archived).toBe(true));

    await admin.post(`/api/v1/company/applications/${application.id}/restore`).expect(204);
    await eventually(() => expect(host.repositories.get(`${organization}/old-service`)!.archived).toBe(false));
  });

  it('refuses to create a repository while archived', async () => {
    const { admin } = await createCompany();
    const application = await register(admin, 'Shelved');
    await admin.post(`/api/v1/company/applications/${application.id}/archive`).expect(204);

    await admin.post(`/api/v1/company/applications/${application.id}/repository`).expect(409);
  });
});

describe('Git access', () => {
  it('puts each member who has a Git account in the team for their role', async () => {
    const { admin, adminName, organization } = await createCompany();
    const developer = await addMember(admin, 'developer');
    const techLead = await addMember(admin, 'tech-lead');
    const viewer = await addMember(admin, 'viewer');
    for (const name of [adminName, developer.name, techLead.name]) {
      host.users.add(gitUser(name));
    }

    await admin.post('/api/v1/company/source-access/sync').expect(201);

    expect(host.teamOf(organization)).toEqual({
      [gitUser(adminName)]: 'readers',
      [gitUser(developer.name)]: 'developers',
      [gitUser(techLead.name)]: 'tech-leads',
    });
    // The viewer hasn't signed in to Forgejo yet, so they join once they do.
    const before = await viewer.agent.get('/api/v1/company/source-access').expect(200);
    expect(before.body).toEqual({
      signInUrl: 'http://git.test/user/oauth2/keycloak',
      gitUrl: 'http://git.test',
      hasAccount: false,
      team: 'readers',
    });
    host.users.add(gitUser(viewer.name));
    const after = await viewer.agent.post('/api/v1/company/source-access/sync').expect(201);
    expect(after.body.hasAccount).toBe(true);
    expect(host.teamOf(organization)[gitUser(viewer.name)]).toBe('readers');
  });

  it('follows role changes and removals at once', async () => {
    const { admin, organization } = await createCompany();
    const member = await addMember(admin, 'developer');
    host.users.add(gitUser(member.name));
    await admin.post('/api/v1/company/source-access/sync').expect(201);

    await admin.patch(`/api/v1/company/members/${member.userId}`).send({ role: 'tech-lead' }).expect(204);
    await eventually(() => expect(host.teamOf(organization)[gitUser(member.name)]).toBe('tech-leads'));

    await admin.delete(`/api/v1/company/members/${member.userId}`).expect(204);
    await eventually(() => expect(host.teamOf(organization)[gitUser(member.name)]).toBeUndefined());
  });

  it('removes people added to a team by hand in Forgejo', async () => {
    const { admin, organization } = await createCompany();
    await admin.post('/api/v1/company/source-access/sync').expect(201);
    await host.addTeamMember(organization, 'tech-leads', 'someone-else');

    await admin.post('/api/v1/company/source-access/sync').expect(201);

    expect(host.teamOf(organization)['someone-else']).toBeUndefined();
  });

  it("removes everyone while the company is suspended, and restores them after", async () => {
    const { platformAdmin, admin, adminName, companyId, organization } = await createCompany();
    host.users.add(gitUser(adminName));
    await admin.post('/api/v1/company/source-access/sync').expect(201);
    expect(host.teamOf(organization)[gitUser(adminName)]).toBe('readers');

    await platformAdmin.post(`/api/v1/platform/companies/${companyId}/suspend`).expect(204);
    await eventually(() => expect(host.teamOf(organization)).toEqual({}));

    await platformAdmin.post(`/api/v1/platform/companies/${companyId}/reactivate`).expect(204);
    await eventually(() => expect(host.teamOf(organization)[gitUser(adminName)]).toBe('readers'));
  });

  it('is refused to users without a company', async () => {
    const platformAdmin = await signIn('platform-admin');

    await platformAdmin.get('/api/v1/company/source-access').expect(403);
    await platformAdmin.get('/api/v1/company/repositories').expect(403);
  });
});

describe('company separation', () => {
  it("keeps each company's repositories apart", async () => {
    const first = await createCompany();
    const second = await createCompany();
    const application = await register(first.admin, 'Private');
    await eventually(async () => expect((await repositoryOf(first.admin, application.id))?.status).toBe('ready'));

    await expect(second.admin.get('/api/v1/company/repositories').expect(200)).resolves.toMatchObject({ body: [] });
    await second.admin.post(`/api/v1/company/applications/${application.id}/repository`).expect(404);
    const appPool = new pg.Pool({ connectionString: database.urlFor('app') });
    try {
      await expect(appPool.query('SELECT * FROM source.repositories')).resolves.toMatchObject({ rows: [] });
      await expect(appPool.query('SELECT * FROM source.member_accounts()')).resolves.toMatchObject({ rows: [] });
    } finally {
      await appPool.end();
    }
  });
});
