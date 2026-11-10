import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IDENTITY_PROVIDER } from '../src/identity-access/application/ports.ts';
import { GIT_PROVIDER, PermanentProvisioningError } from '../src/tenancy/application/ports.ts';
import { FakeGitProvider, FakeIdentityProvider } from './fakes.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';
import { eventually as waitUntil, signIn as signInAs, unique } from './support/integration.ts';

let database: TestDatabase;
let ownerPool: pg.Pool;
let app: INestApplication;
const git = new FakeGitProvider();

const signIn = (user: string) => signInAs(app, user);


const statusOf = async (companyId: string) => {
  const { rows } = await ownerPool.query('SELECT status FROM tenancy.companies WHERE id = $1', [companyId]);
  return rows[0]?.status as string | undefined;
};

const eventually = (assertion: () => Promise<void> | void) => waitUntil(assertion, { interval: 100 });

/** Creates a company through the API and lets its first admin join. */
const createCompany = async (name = unique('Acme')) => {
  const platformAdmin = await signIn('platform-admin');
  const adminName = unique('admin');
  const created = await platformAdmin
    .post('/api/v1/platform/companies')
    .send({ name, firstAdminEmail: `${adminName}@example.com` })
    .expect(201);
  const admin = await signIn(adminName);
  await admin.post('/api/v1/invitations/accept').send({ token: created.body.invitation.token }).expect(200);
  return { platformAdmin, admin, company: created.body.company as { id: string; name: string; slug: string } };
};

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
      { provide: GIT_PROVIDER, useValue: git },
    ],
  });
});

afterAll(async () => {
  await app?.close();
  await ownerPool?.end();
  await database?.stop();
});

beforeEach(() => {
  git.failures.length = 0;
});

describe('creating a company', () => {
  it('provisions its Git organization in the background, then becomes active', async () => {
    const platformAdmin = await signIn('platform-admin');

    const { body } = await platformAdmin
      .post('/api/v1/platform/companies')
      .send({ name: 'Northwind Traders', firstAdminEmail: 'founder@example.com' })
      .expect(201);

    expect(body.company).toMatchObject({ name: 'Northwind Traders', slug: 'northwind-traders', status: 'provisioning' });
    expect(body.invitation.token).toEqual(expect.any(String));
    await eventually(async () => expect(await statusOf(body.company.id)).toBe('active'));
    expect(git.organizations.get('northwind-traders')).toEqual({
      name: 'northwind-traders',
      displayName: 'Northwind Traders',
      companyId: body.company.id,
    });
  });

  it('lets the invited first admin in, with the company name', async () => {
    const { admin, company } = await createCompany('Contoso Labs');

    const { body } = await admin.get('/api/v1/auth/me').expect(200);

    expect(body).toMatchObject({ companyId: company.id, companyName: 'Contoso Labs', role: 'company-admin' });
  });

  it('gives a similar name its own slug', async () => {
    const platformAdmin = await signIn('platform-admin');
    await platformAdmin.post('/api/v1/platform/companies').send({ name: 'Globex', firstAdminEmail: 'a@example.com' });

    const { body } = await platformAdmin
      .post('/api/v1/platform/companies')
      .send({ name: 'Globex!', firstAdminEmail: 'b@example.com' })
      .expect(201);

    expect(body.company.slug).toBe('globex-2');
  });

  it('refuses a name that is taken, regardless of case', async () => {
    const { platformAdmin } = await createCompany('Initech');

    await platformAdmin
      .post('/api/v1/platform/companies')
      .send({ name: 'INITECH', firstAdminEmail: 'c@example.com' })
      .expect(409);
  });

  it.each([
    [{ name: 'x', firstAdminEmail: 'ok@example.com' }],
    [{ name: 'Valid Name', firstAdminEmail: 'not-an-email' }],
    [{}],
  ])('refuses %j without creating anything', async (body) => {
    const platformAdmin = await signIn('platform-admin');
    const before = await ownerPool.query('SELECT count(*)::int AS total FROM tenancy.companies');

    await platformAdmin.post('/api/v1/platform/companies').send(body).expect(400);

    const after = await ownerPool.query('SELECT count(*)::int AS total FROM tenancy.companies');
    expect(after.rows[0].total).toBe(before.rows[0].total);
  });

  it('lists companies for platform admins, with their states', async () => {
    const { platformAdmin, company } = await createCompany();

    const { body } = await platformAdmin.get('/api/v1/platform/companies').expect(200);

    expect(body).toEqual(expect.arrayContaining([expect.objectContaining({ id: company.id, name: company.name })]));
  });
});

describe('who may manage companies', () => {
  it('refuses company admins and members', async () => {
    const { admin, company } = await createCompany();

    await admin.get('/api/v1/platform/companies').expect(403);
    await admin.post('/api/v1/platform/companies').send({ name: 'Mine', firstAdminEmail: 'x@example.com' }).expect(403);
    await admin.post(`/api/v1/platform/companies/${company.id}/suspend`).expect(403);
  });

  it('gives platform admins no access to company data', async () => {
    const { platformAdmin } = await createCompany();

    await platformAdmin.get('/api/v1/company/members').expect(403);
  });

  it('keeps two companies apart', async () => {
    const first = await createCompany();
    const second = await createCompany();

    const seenByFirst = await first.admin.get('/api/v1/company/members').expect(200);
    const seenBySecond = await second.admin.get('/api/v1/company/members').expect(200);
    const secondMember = seenBySecond.body[0].userId as string;

    expect(seenByFirst.body).toHaveLength(1);
    expect(seenByFirst.body[0].userId).not.toBe(secondMember);
    await first.admin.delete(`/api/v1/company/members/${secondMember}`).expect(404);
  });
});

describe('renaming', () => {
  it('renames the company and its Git organization, keeping the slug', async () => {
    const { platformAdmin, admin, company } = await createCompany();
    await eventually(async () => expect(await statusOf(company.id)).toBe('active'));

    await platformAdmin.patch(`/api/v1/platform/companies/${company.id}`).send({ name: 'Renamed Corp' }).expect(204);

    await expect(admin.get('/api/v1/auth/me')).resolves.toMatchObject({ body: { companyName: 'Renamed Corp' } });
    await eventually(() => expect(git.organizations.get(company.slug)?.displayName).toBe('Renamed Corp'));
  });

  it('refuses a name another company uses', async () => {
    const first = await createCompany();
    const second = await createCompany();

    await first.platformAdmin
      .patch(`/api/v1/platform/companies/${first.company.id}`)
      .send({ name: second.company.name.toUpperCase() })
      .expect(409);
  });

  it('answers 404 for an unknown company', async () => {
    const platformAdmin = await signIn('platform-admin');

    await platformAdmin
      .patch('/api/v1/platform/companies/00000000-0000-4000-8000-000000000999')
      .send({ name: 'Nobody' })
      .expect(404);
  });
});

describe('suspending', () => {
  it('blocks every member on their next request, and reactivating restores access', async () => {
    const { platformAdmin, admin, company } = await createCompany();
    await admin.get('/api/v1/company/members').expect(200);

    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/suspend`).expect(204);

    await admin.get('/api/v1/company/members').expect(403);
    await expect(admin.get('/api/v1/auth/me')).resolves.toMatchObject({ body: { companyId: null } });

    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/reactivate`).expect(204);

    await admin.get('/api/v1/company/members').expect(200);
    await eventually(async () => expect(await statusOf(company.id)).toBe('active'));
  });

  it('refuses invitations to a suspended company', async () => {
    const { platformAdmin, admin, company } = await createCompany();
    const invited = unique('invited');
    const { body } = await admin
      .post('/api/v1/company/invitations')
      .send({ email: `${invited}@example.com`, role: 'viewer' })
      .expect(201);

    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/suspend`).expect(204);

    const person = await signIn(invited);
    await person.post('/api/v1/invitations/accept').send({ token: body.token }).expect(404);
    await platformAdmin
      .post(`/api/v1/platform/companies/${company.id}/first-admin-invitation`)
      .send({ email: 'x@example.com' })
      .expect(409);
  });

  it('keeps all data, so nothing is lost', async () => {
    const { platformAdmin, company } = await createCompany();
    const before = await ownerPool.query('SELECT count(*)::int AS total FROM identity.memberships WHERE company_id = $1', [
      company.id,
    ]);

    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/suspend`).expect(204);

    const after = await ownerPool.query('SELECT count(*)::int AS total FROM identity.memberships WHERE company_id = $1', [
      company.id,
    ]);
    expect(after.rows[0].total).toBe(before.rows[0].total);
  });
});

describe('provisioning failures', () => {
  it('retries a passing failure until it succeeds', async () => {
    git.failures.push(new Error('Git service unavailable'), new Error('Git service unavailable'));

    const { company } = await createCompany();

    await eventually(async () => expect(await statusOf(company.id)).toBe('active'));
    expect(git.failures).toHaveLength(0);
  });

  it('stops at a permanent failure, shows why, and can be retried', async () => {
    const platformAdmin = await signIn('platform-admin');
    git.failures.push(new PermanentProvisioningError('The Git organization name "taken" is already taken.'));
    const { body } = await platformAdmin
      .post('/api/v1/platform/companies')
      .send({ name: unique('Unlucky'), firstAdminEmail: 'u@example.com' })
      .expect(201);

    await eventually(async () => expect(await statusOf(body.company.id)).toBe('provisioning-failed'));
    const listed = await platformAdmin.get('/api/v1/platform/companies').expect(200);
    const failed = listed.body.find((company: { id: string }) => company.id === body.company.id);
    expect(failed.provisioningError).toContain('already taken');

    await platformAdmin.post(`/api/v1/platform/companies/${body.company.id}/provision`).expect(204);

    await eventually(async () => expect(await statusOf(body.company.id)).toBe('active'));
  });

  it('gives up after the configured attempts', async () => {
    git.failures.push(...Array.from({ length: 10 }, () => new Error('Still down')));
    const platformAdmin = await signIn('platform-admin');
    const { body } = await platformAdmin
      .post('/api/v1/platform/companies')
      .send({ name: unique('Stubborn'), firstAdminEmail: 's@example.com' })
      .expect(201);

    await eventually(async () => expect(await statusOf(body.company.id)).toBe('provisioning-failed'));
    const { rows } = await ownerPool.query('SELECT attempts FROM tenancy.company_resources WHERE company_id = $1', [
      body.company.id,
    ]);
    expect(rows[0].attempts).toBe(3);
  });
});

describe('events', () => {
  it('records each change in the outbox, with no email addresses', async () => {
    const { platformAdmin, company } = await createCompany();
    await eventually(async () => expect(await statusOf(company.id)).toBe('active'));
    await platformAdmin.patch(`/api/v1/platform/companies/${company.id}`).send({ name: unique('Changed') }).expect(204);
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/suspend`).expect(204);
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/reactivate`).expect(204);

    // Read as the application role in the company's context, as row-level security requires.
    const client = new pg.Client({ connectionString: database.urlFor('app') });
    await client.connect();
    let rows: { event_type: string; payload: object }[];
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [company.id]);
      ({ rows } = await client.query(
        "SELECT event_type, payload FROM kernel.outbox WHERE event_type LIKE 'Company%' ORDER BY sequence",
      ));
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }

    expect(rows.map((row) => row.event_type)).toEqual([
      'CompanyCreated',
      'CompanyProvisioned',
      'CompanyRenamed',
      'CompanySuspended',
      'CompanyReactivated',
      'CompanyProvisioningRequested',
    ]);
    expect(JSON.stringify(rows)).not.toContain('@example.com');
  });

  it('records nothing when a change changes nothing', async () => {
    const { platformAdmin, company } = await createCompany();
    await eventually(async () => expect(await statusOf(company.id)).toBe('active'));
    // Read as the application role in the company's context, as row-level security requires.
    const countEvents = async () => {
      const client = new pg.Client({ connectionString: database.urlFor('app') });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_company_id', $1, true)", [company.id]);
        const { rows } = await client.query("SELECT count(*) AS n FROM kernel.outbox WHERE event_type LIKE 'Company%'");
        await client.query('ROLLBACK');
        return Number(rows[0].n);
      } finally {
        await client.end();
      }
    };
    const before = await countEvents();

    await platformAdmin.patch(`/api/v1/platform/companies/${company.id}`).send({ name: company.name }).expect(204);
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/reactivate`).expect(204);
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/suspend`).expect(204);
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/suspend`).expect(204);

    expect(await countEvents()).toBe(before + 1);
    await platformAdmin.post(`/api/v1/platform/companies/${company.id}/provision`).expect(409);
    await platformAdmin.post('/api/v1/platform/companies/not-an-id/suspend').expect(400);
  });
});
