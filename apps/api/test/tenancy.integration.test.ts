import type { INestApplication } from '@nestjs/common';
import { EventBus } from '@dreamdevops/shared-kernel';
import { OutboxRelay } from '@dreamdevops/shared-kernel/postgres';
import { InMemoryJobQueue } from '@dreamdevops/shared-kernel/testing';
import { runner } from 'node-pg-migrate';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JOB_QUEUE, OUTBOX_RELAY, RELAY_POOL } from '../src/background/background-work.ts';
import { migrateApi } from '../src/database/migrate.ts';
import { IDENTITY_PROVIDER } from '../src/identity-access/application/ports.ts';
import type { PlatformCompany } from '../src/tenancy/application/company-registry.service.ts';
import { GIT_HOSTING } from '../src/tenancy/application/ports.ts';
import { FakeIdentityProvider } from './fakes.ts';
import { InMemoryGitHosting } from './in-memory-git-hosting.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';

let database: TestDatabase;
let appPool: pg.Pool;
let ownerPool: pg.Pool;
let app: INestApplication;
let gitHosting: InMemoryGitHosting;
let platformAdmin: Agent;

// Any type and scaffold from the Application Catalog will do where they aren't what a test is about.
const TYPE = 'typescript-backend';
const SCAFFOLD = 'nestjs';

const eventually = <T>(check: () => Promise<T>) => vi.waitFor(check, { timeout: 15_000, interval: 50 });

const signIn = async (user: string, target = app) => {
  const agent = request.agent(target.getHttpServer());
  const login = await agent.get(`/api/v1/auth/login?login_hint=${user}`).expect(302);
  const callback = new URL(login.headers.location as string);
  await agent.get(callback.pathname + callback.search).expect(302);
  return agent;
};
type Agent = Awaited<ReturnType<typeof signIn>>;

let counter = 0;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
/** The fake login provider takes only letters and hyphens in user names. */
const newName = (prefix: string) => {
  counter += 1;
  return `${prefix}-${LETTERS[Math.floor(counter / 26) % 26]}${LETTERS[counter % 26]}`;
};
const emailOf = (name: string) => `${name}@example.com`;
const newCompanyName = () => {
  counter += 1;
  return `Tenancy Company ${counter}`;
};

const companyOf = async (id: string): Promise<PlatformCompany> =>
  (await platformAdmin.get(`/api/v1/platform/companies/${id}`).expect(200)).body;

const createCompany = async (body: object = { name: newCompanyName() }): Promise<PlatformCompany> =>
  (await platformAdmin.post('/api/v1/platform/companies').send(body).expect(201)).body;

const waitForStatus = (id: string, status: string) =>
  eventually(async () => {
    const company = await companyOf(id);
    expect(company.status).toBe(status);
    return company;
  });

const waitForResource = (id: string, status: string) =>
  eventually(async () => {
    const company = await companyOf(id);
    expect(company.resources[0]?.status).toBe(status);
    return company;
  });

// The queue runs a job once, then five more times.
const ATTEMPTS = 6;

/** Creates a company whose provisioning fails until the retries run out, then lets Git hosting recover. */
const createStuckCompany = async (): Promise<PlatformCompany> => {
  gitHosting.failNext(1_000);
  const created = await createCompany();
  const company = await eventually(async () => {
    const current = await companyOf(created.id);
    expect(current.resources[0]).toMatchObject({ status: 'failed', attempts: ATTEMPTS });
    return current;
  });
  gitHosting.recover();
  return company;
};

/** Creates a company, waits until it's ready, and lets its first admin join. */
const startActiveCompany = async () => {
  const created = await createCompany();
  const company = await waitForStatus(created.id, 'active');
  const name = newName('admin');
  const { body: invitation } = await platformAdmin
    .post(`/api/v1/platform/companies/${company.id}/first-admin-invitation`)
    .send({ email: emailOf(name) })
    .expect(201);
  const admin = await signIn(name);
  await admin.post('/api/v1/invitations/accept').send({ token: invitation.token }).expect(200);
  return { company, admin };
};

const addMember = async (admin: Agent, role: string) => {
  const name = newName('member');
  const { body } = await admin.post('/api/v1/company/invitations').send({ email: emailOf(name), role }).expect(201);
  const member = await signIn(name);
  await member.post('/api/v1/invitations/accept').send({ token: body.token }).expect(200);
  return member;
};

const eventsOf = async (companyId: string) => {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    const { rows } = await client.query<{ event_type: string; payload: object }>(
      'SELECT event_type, payload FROM kernel.outbox ORDER BY sequence',
    );
    await client.query('ROLLBACK');
    return rows;
  } finally {
    client.release();
  }
};

/**
 * Every table and column where any of these strings still appear. The outbox is searched
 * separately, because row-level security shows its rows only to the application role.
 */
const findAnywhere = async (companyId: string, secrets: readonly string[]) => {
  const client = await ownerPool.connect();
  const found: string[] = [];
  try {
    await client.query('BEGIN');
    // Forced row-level security shows applications, even to their owner, only in their company's context.
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    const { rows: columns } = await client.query<{ table_schema: string; table_name: string; column_name: string }>(
      `SELECT c.table_schema, c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t USING (table_schema, table_name)
       WHERE t.table_type = 'BASE TABLE'
         AND c.table_schema IN ('api', 'identity', 'kernel', 'tenancy')
         AND c.data_type IN ('text', 'jsonb', 'character varying')`,
    );
    for (const { table_schema, table_name, column_name } of columns) {
      for (const secret of secrets) {
        const { rows } = await client.query(
          `SELECT 1 FROM "${table_schema}"."${table_name}" WHERE "${column_name}"::text ILIKE $1 LIMIT 1`,
          [`%${secret}%`],
        );
        if (rows.length > 0) {
          found.push(`${table_schema}.${table_name}.${column_name} has "${secret}"`);
        }
      }
    }
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  const events = JSON.stringify(await eventsOf(companyId)).toLowerCase();
  found.push(...secrets.filter((secret) => events.includes(secret.toLowerCase())).map((secret) => `kernel.outbox has "${secret}"`));
  return found;
};

beforeAll(async () => {
  database = await startTestDatabase();
  appPool = new pg.Pool({ connectionString: database.urlFor('app') });
  ownerPool = new pg.Pool({ connectionString: database.urlFor('owner') });
  gitHosting = new InMemoryGitHosting();
  app = await buildApp({
    config: { ...database.config(), secureCookies: false },
    overrides: [
      { provide: IDENTITY_PROVIDER, useValue: new FakeIdentityProvider() },
      { provide: GIT_HOSTING, useValue: gitHosting },
      // Jobs run at once, and the relay checks often, so tests don't wait long.
      { provide: JOB_QUEUE, useValue: new InMemoryJobQueue() },
      {
        provide: OUTBOX_RELAY,
        useFactory: (pool: pg.Pool, bus: EventBus) => new OutboxRelay(pool, bus, { pollIntervalMs: 50 }),
        inject: [RELAY_POOL, EventBus],
      },
    ],
  });
  platformAdmin = await signIn('platform-admin');
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await ownerPool?.end();
  await database?.stop();
});

describe('creating a company', () => {
  it('provisions its Git organization in the background, then activates it', async () => {
    const created = await createCompany({ name: 'Acme Corporation' });

    expect(created).toMatchObject({ name: 'Acme Corporation', slug: 'acme-corporation', memberCount: 0 });
    expect(['provisioning', 'active']).toContain(created.status);
    const company = await waitForStatus(created.id, 'active');
    expect(company.resources).toEqual([
      expect.objectContaining({
        kind: 'git-organization',
        status: 'ready',
        name: 'acme-corporation',
        url: 'http://git.test/acme-corporation',
        lastError: null,
        attempts: 1,
      }),
    ]);
    expect(gitHosting.displayNameOf('acme-corporation')).toBe('Acme Corporation');
  });

  it('publishes what happened, in order', async () => {
    const created = await createCompany();
    await waitForStatus(created.id, 'active');

    const events = await eventsOf(created.id);

    expect(events.map((event) => event.event_type)).toEqual([
      'CompanyCreated',
      'CompanyResourceProvisioned',
      'CompanyProvisioned',
    ]);
  });

  it('uses a chosen slug', async () => {
    const company = await createCompany({ name: 'Globex', slug: 'globex-eu' });

    expect(company.slug).toBe('globex-eu');
  });

  it('never reuses a slug', async () => {
    await createCompany({ name: 'Initech', slug: 'initech' });

    const { body } = await platformAdmin
      .post('/api/v1/platform/companies')
      .send({ name: 'Initech Again', slug: 'initech' })
      .expect(409);

    expect(body.detail).toBe('Another company already uses the slug "initech".');
  });

  it.each([
    [{}, 'Enter a company name'],
    [{ name: '   ' }, 'Enter a company name'],
    [{ name: 'Acme', slug: 'Not A Slug' }, 'A slug has'],
    [{ name: 'Admin' }, 'is reserved'],
    [{ name: '株式会社' }, 'Choose a slug'],
  ])('refuses %j', async (body, message) => {
    const response = await platformAdmin.post('/api/v1/platform/companies').send(body).expect(400);

    expect(response.body.detail).toContain(message);
  });

  it('lists every company with how many members it has, for Platform Admins only', async () => {
    const { company, admin } = await startActiveCompany();

    const { body } = await platformAdmin.get('/api/v1/platform/companies').expect(200);

    expect(body).toContainEqual(expect.objectContaining({ id: company.id, status: 'active', memberCount: 1 }));
    await admin.get('/api/v1/platform/companies').expect(403);
    await admin.post('/api/v1/platform/companies').send({ name: 'Sneaky' }).expect(403);
  });

  it('answers 404 for an unknown company and 400 for a malformed ID', async () => {
    await platformAdmin.get('/api/v1/platform/companies/00000000-0000-4000-8000-000000000000').expect(404);
    await platformAdmin.get('/api/v1/platform/companies/not-an-id').expect(400);
    await platformAdmin.post('/api/v1/platform/companies/00000000-0000-4000-8000-000000000000/suspend').expect(404);
  });
});

describe('provisioning', () => {
  it('tries again by itself after a short outage', async () => {
    gitHosting.failNext(2);

    const created = await createCompany();

    const company = await waitForStatus(created.id, 'active');
    expect(company.resources[0]).toMatchObject({ status: 'ready', attempts: 3 });
  });

  it('shows a failure that outlasts the retries, and provisions again on request', async () => {
    const failed = await createStuckCompany();
    const created = failed;

    expect(failed.status).toBe('provisioning');
    expect(failed.resources[0]!.lastError).toBe('Git hosting could not be reached.');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await companyOf(created.id)).status).toBe('provisioning');

    const requested = await platformAdmin.post(`/api/v1/platform/companies/${created.id}/provisioning`).expect(202);
    expect(requested.body.resources[0]).toMatchObject({ status: 'pending', lastError: null });

    await waitForStatus(created.id, 'active');
  });

  it('does not retry a failure that needs someone to act', async () => {
    gitHosting.addAccount('taken-name');
    const callsBefore = gitHosting.calls;

    const created = await createCompany({ name: 'Taken', slug: 'taken-name' });

    const company = await waitForResource(created.id, 'failed');
    expect(company.resources[0]!.lastError).toContain('already used by an account');
    expect(company.resources[0]!.attempts).toBe(1);
    expect(gitHosting.calls - callsBefore).toBe(1);
    const events = await eventsOf(created.id);
    expect(events.at(-1)).toMatchObject({ event_type: 'CompanyResourceFailed', payload: { willRetry: false } });
  });

  it('brings the Git organization up to date after a rename', async () => {
    const created = await createCompany({ name: 'Umbrella', slug: 'umbrella' });
    await waitForStatus(created.id, 'active');

    const renamed = await platformAdmin
      .patch(`/api/v1/platform/companies/${created.id}`)
      .send({ name: 'Umbrella Health' })
      .expect(200);

    expect(renamed.body).toMatchObject({ name: 'Umbrella Health', slug: 'umbrella' });
    await eventually(async () => expect(gitHosting.displayNameOf('umbrella')).toBe('Umbrella Health'));
  });

  it('stops provisioning a closed company', async () => {
    const created = await createStuckCompany();

    await platformAdmin.post(`/api/v1/platform/companies/${created.id}/close`).expect(200);

    await platformAdmin.post(`/api/v1/platform/companies/${created.id}/provisioning`).expect(409);
    expect((await companyOf(created.id)).resources[0]!.status).toBe('failed');
  });
});

describe('the company lifecycle', () => {
  it('invites a first admin only into an active company', async () => {
    const created = await createStuckCompany();

    const early = await platformAdmin
      .post(`/api/v1/platform/companies/${created.id}/first-admin-invitation`)
      .send({ email: 'founder@example.com' })
      .expect(409);
    expect(early.body.detail).toBe('Invite the first admin once the company is active.');

    await platformAdmin
      .post('/api/v1/platform/companies/00000000-0000-4000-8000-000000000000/first-admin-invitation')
      .send({ email: 'founder@example.com' })
      .expect(404);
  });

  it('shows members the company by name', async () => {
    const { company, admin } = await startActiveCompany();

    const me = await admin.get('/api/v1/auth/me').expect(200);
    const profile = await admin.get('/api/v1/company').expect(200);

    expect(me.body).toMatchObject({
      companyId: company.id,
      companyName: company.name,
      memberships: [{ companyId: company.id, companyName: company.name, role: 'company-admin' }],
    });
    expect(profile.body).toEqual({
      id: company.id,
      slug: company.slug,
      name: company.name,
      status: 'active',
      resources: [{ kind: 'git-organization', status: 'ready', name: company.slug, url: `http://git.test/${company.slug}` }],
    });
  });

  it('takes access away from members while suspended, and gives it back', async () => {
    const { company, admin } = await startActiveCompany();
    const viewer = await addMember(admin, 'viewer');

    const suspended = await platformAdmin.post(`/api/v1/platform/companies/${company.id}/suspend`).expect(200);

    expect(suspended.body.status).toBe('suspended');
    await admin.get('/api/v1/company').expect(403);
    await viewer.get('/api/v1/company/applications').expect(403);
    const me = await admin.get('/api/v1/auth/me').expect(200);
    expect(me.body).toMatchObject({ companyId: null, memberships: [] });

    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/reactivate`).expect(200);

    await admin.get('/api/v1/company').expect(200);
    await viewer.get('/api/v1/company/applications').expect(200);
    expect((await companyOf(company.id)).memberCount).toBe(2);
  });

  it('moves a member to another of their companies when one is suspended', async () => {
    const first = await startActiveCompany();
    const second = await startActiveCompany();
    const name = newName('consultant');
    const invitations = await Promise.all(
      [first.admin, second.admin].map((admin) =>
        admin.post('/api/v1/company/invitations').send({ email: emailOf(name), role: 'viewer' }).expect(201),
      ),
    );
    const consultant = await signIn(name);
    for (const invitation of invitations) {
      await consultant.post('/api/v1/invitations/accept').send({ token: invitation.body.token }).expect(200);
    }

    await platformAdmin.post(`/api/v1/platform/companies/${first.company.id}/suspend`).expect(200);

    const me = await consultant.get('/api/v1/auth/me').expect(200);
    expect(me.body.companyId).toBe(second.company.id);
    await consultant.post('/api/v1/auth/active-company').send({ companyId: first.company.id }).expect(403);
  });

  it('refuses an invitation to a company that is no longer active', async () => {
    const { company, admin } = await startActiveCompany();
    const name = newName('late');
    const { body } = await admin.post('/api/v1/company/invitations').send({ email: emailOf(name), role: 'viewer' });
    const late = await signIn(name);

    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/suspend`).expect(200);

    const refused = await late.post('/api/v1/invitations/accept').send({ token: body.token }).expect(409);
    expect(refused.body.detail).toContain("isn't active");
  });

  it('closes a company for good', async () => {
    const { company, admin } = await startActiveCompany();

    const closed = await platformAdmin.post(`/api/v1/platform/companies/${company.id}/close`).expect(200);

    expect(closed.body.status).toBe('closed');
    await admin.get('/api/v1/company').expect(403);
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/reactivate`).expect(409);
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/close`).expect(409);
    await platformAdmin.patch(`/api/v1/platform/companies/${company.id}`).send({ name: 'Zombie' }).expect(409);
    await platformAdmin.post('/api/v1/platform/companies').send({ name: 'Reuse', slug: company.slug }).expect(409);
  });

  it.each([
    ['suspend', 'provisioning', 'Only an active company can be suspended.'],
    ['reactivate', 'active', 'Only a suspended company can be reactivated.'],
  ])('refuses to %s a company that is %s', async (action, status, message) => {
    const created = status === 'provisioning' ? await createStuckCompany() : await createCompany();
    await waitForStatus(created.id, status);

    const { body } = await platformAdmin.post(`/api/v1/platform/companies/${created.id}/${action}`).expect(409);

    expect(body.detail).toBe(message);
  });

  it('records every lifecycle change as an event, without personal data', async () => {
    const { company } = await startActiveCompany();
    await platformAdmin.patch(`/api/v1/platform/companies/${company.id}`).send({ name: 'Renamed Co' });
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/suspend`);
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/reactivate`);
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/close`);

    const types = (await eventsOf(company.id)).map((event) => event.event_type);

    expect(types).toEqual(
      expect.arrayContaining(['CompanyRenamed', 'CompanySuspended', 'CompanyReactivated', 'CompanyClosed']),
    );
    expect(JSON.stringify(await eventsOf(company.id))).not.toContain('@example.com');
  });
});

describe('events', () => {
  it('hold IDs, never names, slugs, descriptions or reasons for failures', async () => {
    gitHosting.failNext(1);
    const created = await createCompany({ name: 'Secretive Holdings', slug: 'secretive-holdings' });
    await waitForStatus(created.id, 'active');
    const name = newName('secretive');
    const { body: invitation } = await platformAdmin
      .post(`/api/v1/platform/companies/${created.id}/first-admin-invitation`)
      .send({ email: emailOf(name) });
    const admin = await signIn(name);
    await admin.post('/api/v1/invitations/accept').send({ token: invitation.token }).expect(200);
    const { body: application } = await admin
      .post('/api/v1/company/applications')
      .send({ type: TYPE, scaffold: SCAFFOLD, name: 'Hidden Project', description: 'Confidential plans.' })
      .expect(201);
    await admin.patch(`/api/v1/company/applications/${application.id}`).send({ name: 'Hidden Again' }).expect(200);
    await platformAdmin.patch(`/api/v1/platform/companies/${created.id}`).send({ name: 'Secretive Group' }).expect(200);

    const events = JSON.stringify(await eventsOf(created.id));

    for (const secret of ['Secretive', 'secretive-holdings', 'Hidden', 'hidden-project', 'Confidential', 'reached', '@']) {
      expect(events).not.toContain(secret);
    }
  });
});

describe('applications', () => {
  it('lets a Company Admin create, change, archive and restore one', async () => {
    const { admin } = await startActiveCompany();

    const created = await admin
      .post('/api/v1/company/applications')
      .send({ type: TYPE, scaffold: SCAFFOLD, name: 'Billing API', description: 'Bills customers.' })
      .expect(201);
    expect(created.body).toMatchObject({
      slug: 'billing-api',
      name: 'Billing API',
      description: 'Bills customers.',
      status: 'active',
      archivedAt: null,
    });
    const path = `/api/v1/company/applications/${created.body.id}`;

    const updated = await admin.patch(path).send({ name: 'Billing Service', description: '' }).expect(200);
    expect(updated.body).toMatchObject({ name: 'Billing Service', description: '', slug: 'billing-api' });

    const archived = await admin.post(`${path}/archive`).expect(200);
    expect(archived.body).toMatchObject({ status: 'archived', archivedAt: expect.any(String) });
    await admin.patch(path).send({ name: 'Changed While Archived' }).expect(409);
    await admin.post(`${path}/archive`).expect(409);

    const restored = await admin.post(`${path}/restore`).expect(200);
    expect(restored.body).toMatchObject({ status: 'active', archivedAt: null });

    // Its repository is made in the background meanwhile, so only that may differ.
    const listed = await admin.get('/api/v1/company/applications').expect(200);
    const stable = { ...restored.body, repository: expect.objectContaining({ status: expect.any(String) }) };
    expect(listed.body).toEqual([stable]);
    await expect(admin.get(path)).resolves.toMatchObject({ body: stable });
  });

  it('registers each application as a type from the Application Catalog', async () => {
    const { company, admin } = await startActiveCompany();
    const { body: types } = await admin.get('/api/v1/application-types').expect(200);

    for (const type of types as { key: string; name: string; scaffolds: { key: string }[] }[]) {
      const { body } = await admin
        .post('/api/v1/company/applications')
        .send({ type: type.key, scaffold: type.scaffolds[0]!.key, name: `Made as ${type.name}` })
        .expect(201);
      expect(body.type).toBe(type.key);
    }

    const { body: listed } = await admin.get('/api/v1/company/applications').expect(200);
    expect(listed.map((application: { type: string }) => application.type).sort()).toEqual([
      'python-backend',
      'python-frontend',
      'typescript-backend',
      'typescript-frontend',
    ]);
    const created = (await eventsOf(company.id)).filter((event) => event.event_type === 'ApplicationCreated');
    expect(created.map((event) => (event.payload as { type: string }).type).sort()).toEqual([
      'python-backend',
      'python-frontend',
      'typescript-backend',
      'typescript-frontend',
    ]);
  });

  it.each([undefined, '', 'cobol-mainframe', 'TypeScript Frontend', 42])(
    'refuses to register an application as the type %j',
    async (type) => {
      const { admin } = await startActiveCompany();

      const { body } = await admin.post('/api/v1/company/applications').send({ type, name: 'Web' }).expect(400);

      expect(body.detail).toBe('Choose one of the application types in the catalog.');
      await expect(admin.get('/api/v1/company/applications')).resolves.toMatchObject({ body: [] });
    },
  );

  it("never changes an application's type", async () => {
    const { admin } = await startActiveCompany();
    const { body } = await admin
      .post('/api/v1/company/applications')
      .send({ type: 'python-frontend', scaffold: 'streamlit', name: 'Reports' })
      .expect(201);

    const refused = await admin
      .patch(`/api/v1/company/applications/${body.id}`)
      .send({ type: 'python-backend' })
      .expect(400);

    expect(refused.body.detail).toContain("type can't change");
    await expect(admin.get(`/api/v1/company/applications/${body.id}`)).resolves.toMatchObject({
      body: { type: 'python-frontend' },
    });
  });

  it('lists active applications first, then by name', async () => {
    const { admin } = await startActiveCompany();
    const create = (name: string) => admin.post('/api/v1/company/applications').send({ type: TYPE, scaffold: SCAFFOLD, name }).expect(201);
    await create('zeta');
    const alpha = await create('Alpha');
    await create('beta');
    await admin.post(`/api/v1/company/applications/${alpha.body.id}/archive`).expect(200);

    const { body } = await admin.get('/api/v1/company/applications').expect(200);

    expect(body.map((application: { name: string }) => application.name)).toEqual(['beta', 'zeta', 'Alpha']);
  });

  it('keeps slugs unique within a company, but not across companies', async () => {
    const first = await startActiveCompany();
    const second = await startActiveCompany();
    await first.admin.post('/api/v1/company/applications').send({ type: TYPE, scaffold: SCAFFOLD, name: 'Web' }).expect(201);

    const duplicate = await first.admin.post('/api/v1/company/applications').send({ type: TYPE, scaffold: SCAFFOLD, name: 'Web' }).expect(409);
    await second.admin.post('/api/v1/company/applications').send({ type: TYPE, scaffold: SCAFFOLD, name: 'Web' }).expect(201);

    expect(duplicate.body.detail).toBe('Another application in this company already uses the slug "web".');
  });

  it.each([
    [{}, 400],
    [{ name: 'x'.repeat(101) }, 400],
    [{ name: 'Web', slug: 'no spaces' }, 400],
    [{ name: 'Web', description: 42 }, 400],
  ])('refuses to create %j', async (body, status) => {
    const { admin } = await startActiveCompany();

    await admin.post('/api/v1/company/applications').send({ type: TYPE, scaffold: SCAFFOLD, ...body }).expect(status);
  });

  it('refuses changing the slug, or changing nothing', async () => {
    const { admin } = await startActiveCompany();
    const { body } = await admin.post('/api/v1/company/applications').send({ type: TYPE, scaffold: SCAFFOLD, name: 'Web' }).expect(201);

    await admin.patch(`/api/v1/company/applications/${body.id}`).send({ slug: 'other' }).expect(400);
    await admin.patch(`/api/v1/company/applications/${body.id}`).send({}).expect(400);
  });

  it.each([
    ['tech-lead', 201, 200, 200],
    ['developer', 403, 403, 403],
    ['operator', 403, 403, 403],
    ['viewer', 403, 403, 403],
  ])('lets a %s see applications, and answers %i to creating, %i to changing and %i to archiving', async (
    role,
    createStatus,
    updateStatus,
    archiveStatus,
  ) => {
    const { admin } = await startActiveCompany();
    const { body: existing } = await admin.post('/api/v1/company/applications').send({ type: TYPE, scaffold: SCAFFOLD, name: 'Existing' }).expect(201);
    const member = await addMember(admin, role);
    const path = `/api/v1/company/applications/${existing.id}`;

    const { body } = await member.get('/api/v1/company/applications').expect(200);
    await member.get(path).expect(200);
    await member.post('/api/v1/company/applications').send({ type: TYPE, scaffold: SCAFFOLD, name: 'New' }).expect(createStatus);
    await member.patch(path).send({ description: 'Changed.' }).expect(updateStatus);
    await member.post(`${path}/archive`).expect(archiveStatus);

    expect(body.map((application: { name: string }) => application.name)).toContain('Existing');
  });

  it('checks each application permission on its own', async () => {
    // Roles are data, so a role with only some application permissions can exist.
    await ownerPool.query(
      `INSERT INTO identity.roles (key, name, is_company_role) VALUES ('application-editor', 'Application Editor', true)
       ON CONFLICT DO NOTHING`,
    );
    await ownerPool.query(
      `INSERT INTO identity.role_permissions (role_key, permission)
       VALUES ('application-editor', 'applications:view'), ('application-editor', 'applications:update')
       ON CONFLICT DO NOTHING`,
    );
    const { admin } = await startActiveCompany();
    const { body } = await admin.post('/api/v1/company/applications').send({ type: TYPE, scaffold: SCAFFOLD, name: 'Shared' }).expect(201);
    const editor = await addMember(admin, 'application-editor');
    const path = `/api/v1/company/applications/${body.id}`;

    await editor.patch(path).send({ name: 'Shared Renamed' }).expect(200);
    await editor.post(`${path}/archive`).expect(403);
    await editor.post('/api/v1/company/applications').send({ type: TYPE, scaffold: SCAFFOLD, name: 'Another' }).expect(403);
  });

  it("can't see or change another company's applications", async () => {
    const first = await startActiveCompany();
    const second = await startActiveCompany();
    const { body } = await first.admin.post('/api/v1/company/applications').send({ type: TYPE, scaffold: SCAFFOLD, name: 'Secret' }).expect(201);
    const path = `/api/v1/company/applications/${body.id}`;

    await second.admin.get(path).expect(404);
    await second.admin.patch(path).send({ name: 'Stolen' }).expect(404);
    await second.admin.post(`${path}/archive`).expect(404);
    const listed = await second.admin.get('/api/v1/company/applications').expect(200);
    expect(listed.body).toEqual([]);
    await expect(first.admin.get(path)).resolves.toMatchObject({ body: { name: 'Secret', status: 'active' } });
  });

  it('publishes each change, without personal data', async () => {
    const { company, admin } = await startActiveCompany();
    const { body } = await admin.post('/api/v1/company/applications').send({ type: TYPE, scaffold: SCAFFOLD, name: 'Web' }).expect(201);
    await admin.patch(`/api/v1/company/applications/${body.id}`).send({ description: 'The website.' }).expect(200);
    // Changing nothing publishes nothing.
    await admin.patch(`/api/v1/company/applications/${body.id}`).send({ description: 'The website.' }).expect(200);
    await admin.post(`/api/v1/company/applications/${body.id}/archive`).expect(200);
    await admin.post(`/api/v1/company/applications/${body.id}/restore`).expect(200);

    const events = (await eventsOf(company.id)).filter(
      (event) => event.event_type.startsWith('Application') && !event.event_type.startsWith('ApplicationRepository'),
    );

    expect(events).toEqual([
      expect.objectContaining({
        event_type: 'ApplicationCreated',
        payload: { applicationId: body.id, type: TYPE, scaffold: SCAFFOLD, createdBy: expect.any(String) },
      }),
      expect.objectContaining({ event_type: 'ApplicationUpdated', payload: expect.objectContaining({ changed: ['description'] }) }),
      expect.objectContaining({ event_type: 'ApplicationArchived' }),
      expect.objectContaining({ event_type: 'ApplicationRestored' }),
    ]);
    expect(JSON.stringify(events)).not.toContain('@example.com');
  });

  it('are not visible to Platform Admins', async () => {
    await platformAdmin.get('/api/v1/company/applications').expect(403);
    await platformAdmin.get('/api/v1/company').expect(403);
  });
});

describe('erasing a company', () => {
  /** An active company with a member, an application and an invitation nobody accepted. */
  const companyWithData = async () => {
    counter += 1;
    const companyName = `Erasure Target ${counter}`;
    const created = await createCompany({ name: companyName });
    await waitForStatus(created.id, 'active');
    const adminName = newName('erasable');
    const { body: invitation } = await platformAdmin
      .post(`/api/v1/platform/companies/${created.id}/first-admin-invitation`)
      .send({ email: emailOf(adminName) });
    const admin = await signIn(adminName);
    await admin.post('/api/v1/invitations/accept').send({ token: invitation.token }).expect(200);
    const { body: application } = await admin
      .post('/api/v1/company/applications')
      .send({ type: TYPE, scaffold: SCAFFOLD, name: `Payroll Engine ${counter}`, description: 'Salaries for the whole team.' })
      .expect(201);
    const invitee = `pending-person-${counter}@example.com`;
    await admin.post('/api/v1/company/invitations').send({ email: invitee, role: 'viewer' }).expect(201);
    return {
      company: created,
      admin,
      application,
      secrets: [companyName, created.slug, application.name, application.slug, 'Salaries for the whole team', invitee],
    };
  };

  const erase = (company: PlatformCompany, confirmation: unknown = company.slug) =>
    platformAdmin.post(`/api/v1/platform/companies/${company.id}/erase`).send({ confirmation });

  it('replaces everything that identifies the company, and keeps its rows', async () => {
    const { company, admin, application, secrets } = await companyWithData();
    expect(await findAnywhere(company.id, secrets)).not.toEqual([]);
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/close`).expect(200);

    const erased = await erase(company).expect(200);

    expect(erased.body).toMatchObject({
      id: company.id,
      status: 'erased',
      name: `Erased company ${company.id.slice(0, 8)}`,
      slug: `erased-${company.id.replaceAll('-', '')}`,
      erasedAt: expect.any(String),
      resources: [expect.objectContaining({ kind: 'git-organization', name: null, url: null })],
    });
    const done = await waitForResource(company.id, 'erased');
    expect(done.resources[0]).toMatchObject({ name: null, url: null, lastError: null });
    expect(gitHosting.displayNameOf(company.slug)).toBeNull();
    expect(await findAnywhere(company.id, secrets)).toEqual([]);

    // The rows are still there, with nothing left in them that identifies anyone.
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [company.id]);
      const { rows } = await client.query('SELECT id, slug, name, description, status FROM tenancy.applications');
      expect(rows).toEqual([
        {
          id: application.id,
          slug: `erased-${application.id.replaceAll('-', '')}`,
          name: 'Erased application',
          description: '',
          status: 'archived',
        },
      ]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const invitations = await ownerPool.query(
      'SELECT email, revoked_at FROM identity.invitations WHERE company_id = $1 ORDER BY created_at',
      [company.id],
    );
    expect(invitations.rows).toHaveLength(2);
    for (const invitation of invitations.rows) {
      expect(invitation.email).toMatch(/^erased-[0-9a-f-]{36}@erased\.invalid$/);
      expect(invitation.revoked_at).not.toBeNull();
    }
    await admin.get('/api/v1/company').expect(403);
    const types = (await eventsOf(company.id)).map((event) => event.event_type);
    // The application's repository goes first, because the organization can only go once it's empty.
    expect(types.slice(-3)).toEqual(['CompanyErased', 'ApplicationRepositoryErased', 'CompanyResourceErased']);
    expect(gitHosting.hasRepository(company.slug, application.slug)).toBe(false);
  });

  it('only erases a closed company, confirmed with its slug', async () => {
    const { company } = await companyWithData();

    const active = await erase(company).expect(409);
    expect(active.body.detail).toBe('Close the company before erasing its data.');

    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/close`).expect(200);
    const withoutConfirmation = platformAdmin.post(`/api/v1/platform/companies/${company.id}/erase`).send({});
    await withoutConfirmation.expect(400);
    for (const confirmation of [null, '', 'wrong-slug', company.name, company.slug.toUpperCase()]) {
      const refused = await erase(company, confirmation).expect(400);
      expect(refused.body.detail).toBe('To erase this company, confirm with its slug.');
    }
    expect((await companyOf(company.id)).status).toBe('closed');
  });

  it("can't be undone, and leaves nothing to change", async () => {
    const { company } = await companyWithData();
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/close`).expect(200);
    const { body } = await erase(company).expect(200);

    await erase(body).expect(409);
    for (const action of ['reactivate', 'suspend', 'close']) {
      const refused = await platformAdmin.post(`/api/v1/platform/companies/${company.id}/${action}`).expect(409);
      expect(refused.body.detail).toBe("This company's data has been erased, so it can't change.");
    }
    await platformAdmin.patch(`/api/v1/platform/companies/${company.id}`).send({ name: 'Back' }).expect(409);
    await platformAdmin
      .post(`/api/v1/platform/companies/${company.id}/first-admin-invitation`)
      .send({ email: 'someone@example.com' })
      .expect(409);
  });

  it('keeps a Git organization that still has repositories, and erases it once asked again', async () => {
    const { company } = await companyWithData();
    gitHosting.addRepository(company.slug, 'website');
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/close`).expect(200);
    await erase(company).expect(200);

    const blocked = await waitForResource(company.id, 'failed');
    expect(blocked.resources[0]).toMatchObject({ name: null, lastError: expect.stringContaining('repositories') });
    expect(gitHosting.displayNameOf(company.slug)).not.toBeNull();

    gitHosting.removeRepository(company.slug, 'website');
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/provisioning`).expect(202);

    await waitForResource(company.id, 'erased');
    expect(gitHosting.displayNameOf(company.slug)).toBeNull();
  });

  it('tries erasing again by itself after a short outage', async () => {
    const { company, application } = await companyWithData();
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/close`).expect(200);
    gitHosting.failNext(2);

    await erase(company).expect(200);

    await waitForResource(company.id, 'erased');
    expect(gitHosting.hasRepository(company.slug, application.slug)).toBe(false);
    expect(gitHosting.displayNameOf(company.slug)).toBeNull();
  });

  it("never deletes a Git organization that isn't the company's", async () => {
    await gitHosting.ensureOrganization({ name: 'someone-elses', displayName: 'Theirs', companyId: randomUUID() });
    const created = await createCompany({ name: 'Unlucky', slug: 'someone-elses' });
    await waitForResource(created.id, 'failed');
    await platformAdmin.post(`/api/v1/platform/companies/${created.id}/close`).expect(200);

    await erase(created).expect(200);

    await waitForResource(created.id, 'erased');
    expect(gitHosting.displayNameOf('someone-elses')).toBe('Theirs');
  });

  it("frees the company's slug for a new company", async () => {
    const { company } = await companyWithData();
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/close`).expect(200);
    await erase(company).expect(200);
    await waitForResource(company.id, 'erased');

    const reused = await createCompany({ name: 'Fresh Start', slug: company.slug });

    await waitForStatus(reused.id, 'active');
  });

  it('keeps the application role from erasing a company that is not closed', async () => {
    const { company } = await companyWithData();
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [company.id]);
      await expect(client.query('SELECT tenancy.erase_current_company(NULL)')).rejects.toThrow(
        'Only a closed company can be erased.',
      );
      await client.query('ROLLBACK');
      await expect(appPool.query('SELECT identity.erase_current_company_invitations()')).rejects.toThrow(
        'permission denied',
      );
    } finally {
      client.release();
    }
  });
});

describe('application repositories', () => {
  const waitForRepository = (admin: Agent, applicationId: string, status: string) =>
    eventually(async () => {
      const { body } = await admin.get(`/api/v1/company/applications/${applicationId}`).expect(200);
      expect(body.repository?.status).toBe(status);
      return body;
    });

  it.each([
    ['typescript-frontend', 'angular', 'Angular', 'package.json', 'src/about.json'],
    ['typescript-frontend', 'react', 'React', 'package.json', 'src/about.json'],
    ['typescript-backend', 'nestjs', 'NestJS', 'package.json', 'src/about.json'],
    ['python-frontend', 'streamlit', 'Streamlit', 'pyproject.toml', 'src/app/about.json'],
    ['python-backend', 'fastapi', 'FastAPI', 'pyproject.toml', 'src/app/about.json'],
  ])('makes a %s repository from the %s scaffold', async (type, scaffold, scaffoldName, manifest, about) => {
    const { company, admin } = await startActiveCompany();
    const name = `Billing "Portal" <${scaffold}>`;

    const { body: created } = await admin
      .post('/api/v1/company/applications')
      .send({ type, scaffold, name, slug: `billing-${scaffold}`, description: 'Bills customers.\nEvery month.' })
      .expect(201);
    expect(created).toMatchObject({ type, scaffold, repository: { status: 'pending', url: null } });

    const ready = await waitForRepository(admin, created.id, 'ready');
    expect(ready.repository).toEqual({
      status: 'ready',
      name: `billing-${scaffold}`,
      url: `http://git.test/${company.slug}/billing-${scaffold}`,
      lastError: null,
    });
    const files = gitHosting.filesOf(company.slug, `billing-${scaffold}`)!;
    expect(files.get(manifest)).toContain(`"billing-${scaffold}"`);
    // The scaffold's README replaces the one Git hosting made with the repository.
    expect(files.get('README.md')).toMatch(/^# Billing "Portal" \\<.+\\>\n/);
    expect(gitHosting.topicsOf(company.slug, `billing-${scaffold}`)).toEqual([type, scaffold]);
    expect(JSON.parse(files.get(about)!)).toEqual({ name, description: 'Bills customers.\nEvery month.' });
    expect(files.has('README.md')).toBe(true);
    expect(gitHosting.lastCommitMessage).toBe(`Start from the DreamDevOps ${scaffoldName} scaffold`);
    const types = (await eventsOf(company.id)).map((event) => event.event_type);
    expect(types).toContain('ApplicationRepositoryCreated');
  });

  it("makes the company's organization again if it has gone from Git hosting", async () => {
    const { company, admin } = await startActiveCompany();
    await gitHosting.eraseOrganization({ name: company.slug, companyId: company.id });
    expect(gitHosting.displayNameOf(company.slug)).toBeNull();

    const { body } = await admin
      .post('/api/v1/company/applications')
      .send({ type: TYPE, scaffold: SCAFFOLD, name: 'After Reset' })
      .expect(201);

    await waitForRepository(admin, body.id, 'ready');
    expect(gitHosting.displayNameOf(company.slug)).toBe(company.name);
    expect(gitHosting.filesOf(company.slug, 'after-reset')?.has('package.json')).toBe(true);
  });

  it('starts an empty repository when asked for no scaffold', async () => {
    const { company, admin } = await startActiveCompany();

    const { body } = await admin
      .post('/api/v1/company/applications')
      .send({ type: 'python-backend', scaffold: null, name: 'Imported Service' })
      .expect(201);

    await waitForRepository(admin, body.id, 'ready');
    expect(body.scaffold).toBeNull();
    // Only what Git hosting made with it.
    expect([...gitHosting.filesOf(company.slug, 'imported-service')!.keys()]).toEqual(['README.md']);
    expect(gitHosting.topicsOf(company.slug, 'imported-service')).toEqual(['python-backend']);
  });

  it.each([undefined, 'fastapi', 'vue'])('refuses the scaffold %j for a TypeScript frontend', async (scaffold) => {
    const { admin } = await startActiveCompany();

    const { body } = await admin
      .post('/api/v1/company/applications')
      .send({ type: 'typescript-frontend', scaffold, name: 'Web' })
      .expect(400);

    expect(body.detail).toBe('Choose a scaffold for this type: angular, react, or none for an empty repository.');
  });

  it("never changes an application's scaffold", async () => {
    const { admin } = await startActiveCompany();
    const { body } = await admin
      .post('/api/v1/company/applications')
      .send({ type: 'typescript-frontend', scaffold: 'react', name: 'Web' })
      .expect(201);

    const { body: refused } = await admin
      .patch(`/api/v1/company/applications/${body.id}`)
      .send({ scaffold: 'angular' })
      .expect(400);

    expect(refused.detail).toContain("scaffold can't change");
  });

  it('tries again by itself after a short outage', async () => {
    const { admin } = await startActiveCompany();
    gitHosting.failNext(2);

    const { body } = await admin
      .post('/api/v1/company/applications')
      .send({ type: TYPE, scaffold: SCAFFOLD, name: 'Flaky' })
      .expect(201);

    await waitForRepository(admin, body.id, 'ready');
  });

  it('shows a failure that outlasts the retries, and tries again on request', async () => {
    const { company, admin } = await startActiveCompany();
    gitHosting.failNext(1_000);
    const { body } = await admin
      .post('/api/v1/company/applications')
      .send({ type: TYPE, scaffold: SCAFFOLD, name: 'Stuck' })
      .expect(201);
    const failed = await waitForRepository(admin, body.id, 'failed');
    expect(failed.repository.lastError).toBe('Git hosting could not be reached.');
    // The queue runs a job once, then five more times. Recovering sooner would let a retry succeed.
    await eventually(async () => {
      const { rows } = await ownerPool.query(
        'SELECT attempts FROM tenancy.application_resources WHERE application_id = $1',
        [body.id],
      );
      expect(rows[0].attempts).toBe(ATTEMPTS);
    });
    gitHosting.recover();

    const requested = await admin.post(`/api/v1/company/applications/${body.id}/repository`).expect(202);
    expect(requested.body.repository).toMatchObject({ status: 'pending', lastError: null });

    await waitForRepository(admin, body.id, 'ready');
    expect(gitHosting.filesOf(company.slug, 'stuck')?.has('package.json')).toBe(true);
    await admin.post(`/api/v1/company/applications/${body.id}/repository`).expect(409);
  });

  it('lets only those who may create applications ask for a repository again', async () => {
    const { admin } = await startActiveCompany();
    const { body } = await admin
      .post('/api/v1/company/applications')
      .send({ type: TYPE, scaffold: SCAFFOLD, name: 'Guarded' })
      .expect(201);
    const viewer = await addMember(admin, 'viewer');

    await viewer.post(`/api/v1/company/applications/${body.id}/repository`).expect(403);
    const { body: seen } = await viewer.get(`/api/v1/company/applications/${body.id}`).expect(200);
    expect(seen.repository).toMatchObject({ status: expect.any(String) });
  });

  it("erases the applications' repositories with the company, then its organization", async () => {
    const { company, admin } = await startActiveCompany();
    for (const [type, scaffold, name] of [
      ['typescript-frontend', 'react', 'Shop'],
      ['python-backend', 'fastapi', 'Orders'],
    ] as const) {
      const { body } = await admin.post('/api/v1/company/applications').send({ type, scaffold, name }).expect(201);
      await waitForRepository(admin, body.id, 'ready');
    }
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/close`).expect(200);

    await platformAdmin
      .post(`/api/v1/platform/companies/${company.id}/erase`)
      .send({ confirmation: company.slug })
      .expect(200);

    await waitForResource(company.id, 'erased');
    expect(gitHosting.hasRepository(company.slug, 'shop')).toBe(false);
    expect(gitHosting.hasRepository(company.slug, 'orders')).toBe(false);
    expect(gitHosting.displayNameOf(company.slug)).toBeNull();
    expect(await findAnywhere(company.id, [company.name, company.slug, 'Shop', 'Orders'])).toEqual([]);
    const types = (await eventsOf(company.id)).map((event) => event.event_type);
    expect(types.filter((type) => type === 'ApplicationRepositoryErased')).toHaveLength(2);
  });
});

describe('storage', () => {
  it('shows the application role nothing without a company', async () => {
    const { admin } = await startActiveCompany();
    await admin.post('/api/v1/company/applications').send({ type: TYPE, scaffold: SCAFFOLD, name: 'Hidden' }).expect(201);

    for (const table of ['tenancy.companies', 'tenancy.company_resources', 'tenancy.applications']) {
      await expect(appPool.query(`SELECT * FROM ${table}`)).resolves.toMatchObject({ rows: [] });
    }
  });

  it('forces row-level security on applications, even for their owner', async () => {
    const { admin } = await startActiveCompany();
    await admin.post('/api/v1/company/applications').send({ type: TYPE, scaffold: SCAFFOLD, name: 'Forced' }).expect(201);

    const { rows } = await ownerPool.query('SELECT count(*)::int AS total FROM tenancy.applications');

    expect(rows[0].total).toBe(0);
  });

  it("keeps the application role from deleting anything or changing what mustn't change", async () => {
    const { company } = await startActiveCompany();
    const client = await appPool.connect();
    try {
      for (const statement of [
        'DELETE FROM tenancy.applications',
        'DELETE FROM tenancy.companies',
        "UPDATE tenancy.companies SET slug = 'changed'",
        "UPDATE tenancy.applications SET slug = 'changed'",
        "UPDATE tenancy.applications SET type = 'python-backend'",
        "UPDATE tenancy.applications SET scaffold = 'fastapi'",
        'DELETE FROM tenancy.application_resources',
      ]) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_company_id', $1, true)", [company.id]);
        await expect(client.query(statement)).rejects.toThrow('permission denied');
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('refuses a membership or invitation in a company that does not exist', async () => {
    await expect(
      ownerPool.query(
        `INSERT INTO identity.memberships (company_id, user_id, role_key)
         SELECT '00000000-0000-4000-8000-000000000000', id, 'viewer' FROM identity.users LIMIT 1`,
      ),
    ).rejects.toThrow('memberships_company_id_fkey');
  });
});

describe('through the real job queue', () => {
  // Its own database, so the other application's relay can't take its events.
  it('provisions a company', async () => {
    const ownDatabase = await startTestDatabase();
    const realHosting = new InMemoryGitHosting();
    const realApp = await buildApp({
      config: { ...ownDatabase.config(), secureCookies: false },
      overrides: [
        { provide: IDENTITY_PROVIDER, useValue: new FakeIdentityProvider() },
        { provide: GIT_HOSTING, useValue: realHosting },
      ],
    });
    try {
      const admin = await signIn('platform-admin', realApp);
      const { body } = await admin.post('/api/v1/platform/companies').send({ name: 'Queued Co' }).expect(201);

      await vi.waitFor(
        async () => {
          const company = await admin.get(`/api/v1/platform/companies/${body.id}`).expect(200);
          expect(company.body.status).toBe('active');
        },
        { timeout: 30_000, interval: 250 },
      );
      expect(realHosting.displayNameOf('queued-co')).toBe('Queued Co');
      // The queue keeps copies of events for a while, so they must hold no names either.
      const jobs = new pg.Pool({ connectionString: ownDatabase.urlFor('jobs') });
      try {
        const { rows } = await jobs.query("SELECT data FROM pgboss.job WHERE name LIKE 'events.%'");
        expect(rows.length).toBeGreaterThan(0);
        expect(JSON.stringify(rows)).not.toMatch(/queued/i);
      } finally {
        await jobs.end();
      }
    } finally {
      await realApp.close();
      await ownDatabase.stop();
    }
  });
});

describe('upgrading a database from before Tenancy', () => {
  it('gives existing companies a registry entry, so their members keep access', async () => {
    const old = await startTestDatabase({ migrateApi: false });
    const pool = new pg.Pool({ connectionString: old.urlFor('owner') });
    try {
      await runner({
        databaseUrl: old.urlFor('owner'),
        dir: fileURLToPath(new URL('../migrations', import.meta.url)),
        direction: 'up',
        count: 3,
        migrationsTable: 'api_migrations',
        schema: 'api',
        createSchema: true,
        log: () => {},
      });
      const companyId = '4707316c-b477-41ae-b8eb-0ddd1ef86f79';
      const { rows } = await pool.query<{ id: string }>(
        "SELECT identity.record_login('old|user', 'old@example.com', true, 'Old User', false) AS id",
      );
      await pool.query("INSERT INTO identity.memberships (company_id, user_id, role_key) VALUES ($1, $2, 'company-admin')", [
        companyId,
        rows[0]!.id,
      ]);

      await expect(migrateApi(old.urlFor('owner'))).resolves.toEqual([
        '0004_create-tenancy',
        '0005_add-application-permissions',
        '0006_add-company-erasure',
        '0007_add-application-types',
        '0008_add-application-repositories',
      ]);

      const company = await pool.query('SELECT slug, name, status FROM tenancy.companies WHERE id = $1', [companyId]);
      expect(company.rows).toEqual([
        { slug: 'company-4707316cb47741aeb8eb0ddd1ef86f79', name: 'Company 4707316c', status: 'active' },
      ]);
      const access = await pool.query('SELECT identity.user_access($1) AS access', [rows[0]!.id]);
      expect(access.rows[0].access.memberships).toEqual([
        expect.objectContaining({ companyId, companyName: 'Company 4707316c', role: 'company-admin' }),
      ]);
      const resources = await pool.query('SELECT kind, status FROM tenancy.company_resources');
      expect(resources.rows).toEqual([{ kind: 'git-organization', status: 'pending' }]);
    } finally {
      await pool.end();
      await old.stop();
    }
  });
});
