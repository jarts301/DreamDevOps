import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEMO_COMPANY_NAME, DemoCompany } from '../../src/demo/demo-company.ts';
import { DEMO_ENVIRONMENT_NAME } from '../../src/demo/demo-applications.ts';
import { IDENTITY_PROVIDER } from '../../src/identity-access/application/ports.ts';
import { GIT_PROVIDER } from '../../src/tenancy/application/ports.ts';
import { FakeGitProvider, FakeIdentityProvider } from '../fakes.ts';
import { buildApp } from '../test-app.ts';
import { startTestDatabase, type TestDatabase } from '../test-database.ts';

let database: TestDatabase;
let superuser: pg.Pool;
let app: INestApplication;

const members = async () =>
  (
    await superuser.query<{ email: string; role_key: string }>(
      `SELECT u.email, m.role_key FROM identity.memberships m
       JOIN identity.users u ON u.id = m.user_id
       JOIN tenancy.companies c ON c.id = m.company_id
       WHERE c.name = $1 ORDER BY u.email`,
      [DEMO_COMPANY_NAME],
    )
  ).rows;

const EXPECTED = [
  { email: 'demo-company-admin@example.com', role_key: 'company-admin' },
  { email: 'demo-developer@example.com', role_key: 'developer' },
  { email: 'demo-operator@example.com', role_key: 'operator' },
  { email: 'demo-tech-lead@example.com', role_key: 'tech-lead' },
  { email: 'demo-viewer@example.com', role_key: 'viewer' },
];

beforeAll(async () => {
  database = await startTestDatabase();
  superuser = new pg.Pool({ connectionString: database.superuserUrl() });
  app = await buildApp({
    background: true,
    config: {
      databaseUrl: database.urlFor('app'),
      relayDatabaseUrl: database.urlFor('relay'),
      jobsDatabaseUrl: database.urlFor('jobs'),
      secureCookies: false,
      demoData: true,
      demoApplications: true,
    },
    overrides: [
      { provide: IDENTITY_PROVIDER, useValue: new FakeIdentityProvider() },
      { provide: GIT_PROVIDER, useValue: new FakeGitProvider() },
    ],
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await superuser?.end();
  await database?.stop();
});

describe('the demo company', () => {
  it('is created at startup, with one demo user in each role', async () => {
    expect(await members()).toEqual(EXPECTED);
    const { rows } = await superuser.query<{ platform_admin: boolean }>(
      'SELECT platform_admin FROM identity.users WHERE email = $1',
      ['demo-platform-admin@example.com'],
    );
    expect(rows[0]?.platform_admin).toBe(true);
  });

  it('is set up the usual way, so it is provisioned and its history is recorded', async () => {
    await vi.waitFor(
      async () => {
        const { rows } = await superuser.query<{ status: string }>('SELECT status FROM tenancy.companies WHERE name = $1', [
          DEMO_COMPANY_NAME,
        ]);
        expect(rows[0]?.status).toBe('active');
        const { rows: entries } = await superuser.query<{ event_type: string }>(
          `SELECT a.event_type FROM audit.entries a JOIN tenancy.companies c ON c.id = a.company_id WHERE c.name = $1`,
          [DEMO_COMPANY_NAME],
        );
        expect(entries.map((entry) => entry.event_type)).toEqual(
          expect.arrayContaining(['CompanyCreated', 'UserInvited', 'RoleGranted']),
        );
      },
      { timeout: 20_000, interval: 200 },
    );
  });

  it('is left as it is when set up again, and missing members rejoin', async () => {
    await superuser.query(
      `DELETE FROM identity.memberships WHERE user_id = (SELECT id FROM identity.users WHERE email = 'demo-viewer@example.com')`,
    );

    await app.get(DemoCompany).setUp();
    await app.get(DemoCompany).setUp();

    expect(await members()).toEqual(EXPECTED);
    const { rows } = await superuser.query('SELECT 1 FROM tenancy.companies WHERE name = $1', [DEMO_COMPANY_NAME]);
    expect(rows).toHaveLength(1);
  });

  it('gets a demo application for each blueprint, registered by its Tech Lead, and a Test environment on This machine', async () => {
    const applications = async () =>
      (
        await superuser.query<{ name: string; created_by_email: string }>(
          `SELECT a.name, u.email AS created_by_email FROM catalog.applications a
           JOIN tenancy.companies c ON c.id = a.company_id
           JOIN identity.users u ON u.id = a.created_by
           WHERE c.name = $1`,
          [DEMO_COMPANY_NAME],
        )
      ).rows;
    await vi.waitFor(async () => expect(await applications()).toHaveLength(18), { timeout: 60_000, interval: 250 });
    expect(new Set((await applications()).map((row) => row.created_by_email))).toEqual(new Set(['demo-tech-lead@example.com']));
    const { rows: environments } = await superuser.query<{ name: string; kind: string; provider: string | null }>(
      `SELECT e.name, e.kind, t.provider FROM environments.environments e
       JOIN tenancy.companies c ON c.id = e.company_id
       LEFT JOIN environments.targets t ON t.environment_id = e.id
       WHERE c.name = $1`,
      [DEMO_COMPANY_NAME],
    );
    expect(environments).toEqual([{ name: DEMO_ENVIRONMENT_NAME, kind: 'test', provider: 'local' }]);

    // Once there, nothing is added again, even for an application someone archived.
    const companyId = (await superuser.query<{ id: string }>('SELECT id FROM tenancy.companies WHERE name = $1', [DEMO_COMPANY_NAME])).rows[0]!.id;
    const { techLead } = await app.get(DemoCompany).setUp();
    await app.get(DemoCompany).addApplications(companyId, techLead);
    expect(await applications()).toHaveLength(18);
  }, 90_000);
});
