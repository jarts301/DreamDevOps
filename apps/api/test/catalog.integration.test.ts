import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IDENTITY_PROVIDER } from '../src/identity-access/application/ports.ts';
import { GIT_PROVIDER } from '../src/tenancy/application/ports.ts';
import { FakeGitProvider, FakeIdentityProvider } from './fakes.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';

let database: TestDatabase;
let ownerPool: pg.Pool;
let app: INestApplication;

const eventually = (assertion: () => Promise<void> | void) => vi.waitFor(assertion, { timeout: 20_000, interval: 150 });

const signIn = async (user: string) => {
  const agent = request.agent(app.getHttpServer());
  const login = await agent.get(`/api/v1/auth/login?login_hint=${user}`).expect(302);
  const callback = new URL(login.headers.location as string);
  await agent.get(callback.pathname + callback.search).expect(302);
  return agent;
};
type Agent = Awaited<ReturnType<typeof signIn>>;

let counter = 0;
const unique = (prefix: string) => {
  counter += 1;
  return `${prefix}-${'abcdefghijklmnopqrstuvwxyz'[Math.floor(counter / 26) % 26]}${'abcdefghijklmnopqrstuvwxyz'[counter % 26]}`;
};

const createCompany = async () => {
  const platformAdmin = await signIn('platform-admin');
  const adminName = unique('admin');
  const { body } = await platformAdmin
    .post('/api/v1/platform/companies')
    .send({ name: unique('Company'), firstAdminEmail: `${adminName}@example.com` })
    .expect(201);
  const admin = await signIn(adminName);
  await admin.post('/api/v1/invitations/accept').send({ token: body.invitation.token }).expect(200);
  return { platformAdmin, admin, companyId: body.company.id as string };
};

const addMember = async (admin: Agent, role: string) => {
  const name = unique(role);
  const { body } = await admin
    .post('/api/v1/company/invitations')
    .send({ email: `${name}@example.com`, role })
    .expect(201);
  const member = await signIn(name);
  await member.post('/api/v1/invitations/accept').send({ token: body.token }).expect(200);
  return member;
};

const register = (agent: Agent, name: string, type = 'restful-service', description?: string) =>
  agent.post('/api/v1/company/applications').send({ name, type, description });

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
    },
    overrides: [
      { provide: IDENTITY_PROVIDER, useValue: new FakeIdentityProvider() },
      { provide: GIT_PROVIDER, useValue: new FakeGitProvider() },
    ],
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await ownerPool?.end();
  await database?.stop();
});

describe('application types', () => {
  it('offer the starter types to every member', async () => {
    const { admin } = await createCompany();
    const viewer = await addMember(admin, 'viewer');

    const { body } = await viewer.get('/api/v1/company/application-types').expect(200);

    expect(body.map((type: { key: string }) => type.key)).toEqual(['restful-service', 'web-frontend']);
    expect(body[0]).toMatchObject({ name: 'RESTful Service', description: expect.any(String) });
  });

  it('leave out types that are no longer available', async () => {
    const { admin } = await createCompany();
    await ownerPool.query(
      "INSERT INTO catalog.application_types (key, name, description, available) VALUES ('retired-type', 'Retired', 'Old', false)",
    );

    const { body } = await admin.get('/api/v1/company/application-types').expect(200);
    await register(admin, unique('App'), 'retired-type').expect(400);

    expect(body.map((type: { key: string }) => type.key)).not.toContain('retired-type');
  });
});

describe('registering an application', () => {
  it('records it with a short name, its type and who registered it', async () => {
    const { admin } = await createCompany();

    const { body } = await register(admin, '  Billing   API ', 'restful-service', 'Charges customers').expect(201);

    expect(body).toMatchObject({
      id: expect.any(String),
      name: 'Billing API',
      slug: 'billing-api',
      type: { key: 'restful-service', name: 'RESTful Service' },
      description: 'Charges customers',
      status: 'active',
      archivedAt: null,
      createdBy: { displayName: expect.stringMatching(/^admin-/) },
    });
    const { body: list } = await admin.get('/api/v1/company/applications').expect(200);
    expect(list).toEqual([body]);
    await expect(admin.get(`/api/v1/company/applications/${body.id}`).expect(200)).resolves.toMatchObject({ body });
  });

  it('numbers the short name when a similar name has it', async () => {
    const { admin } = await createCompany();
    await register(admin, 'Billing API').expect(201);

    const { body } = await register(admin, 'Billing-API!').expect(201);

    expect(body.slug).toBe('billing-api-2');
  });

  it('refuses a name already in use, ignoring case', async () => {
    const { admin } = await createCompany();
    await register(admin, 'Billing').expect(201);

    const { body } = await register(admin, 'BILLING').expect(409);

    expect(body.detail).toBe('Another application already has this name.');
  });

  it('lets two people register at the same time without clashing', async () => {
    const { admin } = await createCompany();

    const responses = await Promise.all([register(admin, 'Orders'), register(admin, 'Orders!')]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 201]);
    expect(responses.map((response) => response.body.slug).sort()).toEqual(['orders', 'orders-2']);
  });

  it('refuses bad input', async () => {
    const { admin } = await createCompany();

    await register(admin, 'x').expect(400);
    await register(admin, 'Fine name', 'cobol-mainframe').expect(400);
    await register(admin, 'Fine name', 'web-frontend', 'x'.repeat(501)).expect(400);
  });

  it('is allowed to Tech Leads and Company Admins only', async () => {
    const { admin } = await createCompany();
    const techLead = await addMember(admin, 'tech-lead');

    await register(techLead, unique('App')).expect(201);
    for (const role of ['developer', 'operator', 'viewer']) {
      const member = await addMember(admin, role);
      await register(member, unique('App')).expect(403);
      await member.get('/api/v1/company/applications').expect(200);
    }
  });
});

describe('editing an application', () => {
  it('changes the name and description, but keeps the short name', async () => {
    const { admin } = await createCompany();
    const { body: created } = await register(admin, 'Billing').expect(201);

    await admin
      .patch(`/api/v1/company/applications/${created.id}`)
      .send({ name: 'Payments', description: 'Takes payments' })
      .expect(204);

    const { body } = await admin.get(`/api/v1/company/applications/${created.id}`).expect(200);
    expect(body).toMatchObject({ name: 'Payments', slug: 'billing', description: 'Takes payments' });
  });

  it("refuses another application's name", async () => {
    const { admin } = await createCompany();
    await register(admin, 'Billing').expect(201);
    const { body: other } = await register(admin, 'Orders').expect(201);

    await admin.patch(`/api/v1/company/applications/${other.id}`).send({ name: 'billing' }).expect(409);
  });
});

describe('archiving an application', () => {
  it('hides it from the list until it is restored, and keeps its name reserved', async () => {
    const { admin } = await createCompany();
    const { body: created } = await register(admin, 'Legacy').expect(201);

    await admin.post(`/api/v1/company/applications/${created.id}/archive`).expect(204);

    await expect(admin.get('/api/v1/company/applications').expect(200)).resolves.toMatchObject({ body: [] });
    const { body: archived } = await admin.get('/api/v1/company/applications?status=archived').expect(200);
    expect(archived).toEqual([expect.objectContaining({ id: created.id, status: 'archived', archivedAt: expect.any(String) })]);
    const conflict = await register(admin, 'Legacy').expect(409);
    expect(conflict.body.detail).toBe('An archived application already has this name.');
    await admin.patch(`/api/v1/company/applications/${created.id}`).send({ name: 'Renamed' }).expect(409);

    await admin.post(`/api/v1/company/applications/${created.id}/restore`).expect(204);

    const { body: restored } = await admin.get(`/api/v1/company/applications/${created.id}`).expect(200);
    expect(restored).toMatchObject({ status: 'active', archivedAt: null });
  });

  it('refuses an unknown status filter', async () => {
    const { admin } = await createCompany();

    await admin.get('/api/v1/company/applications?status=deleted').expect(400);
  });

  it('is allowed to Tech Leads and Company Admins only', async () => {
    const { admin } = await createCompany();
    const { body: created } = await register(admin, 'Kept').expect(201);
    const developer = await addMember(admin, 'developer');

    await developer.post(`/api/v1/company/applications/${created.id}/archive`).expect(403);
    await developer.patch(`/api/v1/company/applications/${created.id}`).send({ name: 'Mine' }).expect(403);
  });
});

describe('the audit log', () => {
  it('records each change, with who made it', async () => {
    const { admin } = await createCompany();
    const { body: created } = await register(admin, 'Audited').expect(201);
    await admin.patch(`/api/v1/company/applications/${created.id}`).send({ name: 'Audited App' }).expect(204);
    await admin.patch(`/api/v1/company/applications/${created.id}`).send({ name: 'Audited App' }).expect(204);
    await admin.post(`/api/v1/company/applications/${created.id}/archive`).expect(204);
    await admin.post(`/api/v1/company/applications/${created.id}/restore`).expect(204);

    await eventually(async () => {
      const { body } = await admin.get('/api/v1/company/audit').expect(200);
      const entries = (body.entries as { eventType: string; actor: { displayName: string } | null; payload: object }[])
        .filter((entry) => entry.eventType.startsWith('Application'));
      // Saving the same name again changes nothing, so it isn't recorded.
      expect(entries.map((entry) => entry.eventType).sort()).toEqual(
        ['ApplicationArchived', 'ApplicationRegistered', 'ApplicationRestored', 'ApplicationUpdated'].sort(),
      );
      expect(entries.every((entry) => entry.actor?.displayName.startsWith('admin-'))).toBe(true);
      expect(entries.find((entry) => entry.eventType === 'ApplicationUpdated')!.payload).toMatchObject({
        name: 'Audited App',
        previousName: 'Audited',
        descriptionChanged: false,
      });
    });
  });
});

describe('company separation', () => {
  it("keeps each company's applications apart", async () => {
    const first = await createCompany();
    const second = await createCompany();
    const { body: created } = await register(first.admin, 'Private').expect(201);

    await expect(second.admin.get('/api/v1/company/applications').expect(200)).resolves.toMatchObject({ body: [] });
    await second.admin.get(`/api/v1/company/applications/${created.id}`).expect(404);
    await second.admin.post(`/api/v1/company/applications/${created.id}/archive`).expect(404);
    // The same name and short name are free in another company.
    await expect(register(second.admin, 'Private').expect(201)).resolves.toMatchObject({ body: { slug: 'private' } });
  });

  it('is enforced by the database too', async () => {
    const { admin, companyId } = await createCompany();
    await register(admin, 'Guarded').expect(201);
    const appPool = new pg.Pool({ connectionString: database.urlFor('app') });
    try {
      const { rows } = await appPool.query('SELECT * FROM catalog.applications WHERE company_id = $1', [companyId]);
      expect(rows).toHaveLength(0);
      await expect(appPool.query('DELETE FROM catalog.applications')).rejects.toThrow(/permission denied/);
    } finally {
      await appPool.end();
    }
  });

  it('refuses users without a company', async () => {
    const platformAdmin = await signIn('platform-admin');

    await platformAdmin.get('/api/v1/company/applications').expect(403);
    await platformAdmin.get('/api/v1/company/application-types').expect(403);
  });
});
