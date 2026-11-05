import type { INestApplication } from '@nestjs/common';
import { EventBus } from '@dreamdevops/shared-kernel';
import { OutboxRelay } from '@dreamdevops/shared-kernel/postgres';
import { InMemoryJobQueue } from '@dreamdevops/shared-kernel/testing';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEMO_COMPANY, DEMO_MEMBERS, PLATFORM_ADMIN, seedDemoCompany } from '../scripts/demo-company.ts';
import { JOB_QUEUE, OUTBOX_RELAY, RELAY_POOL } from '../src/background/background-work.ts';
import { IDENTITY_PROVIDER } from '../src/identity-access/application/ports.ts';
import { GIT_HOSTING } from '../src/tenancy/application/ports.ts';
import { FakeIdentityProvider } from './fakes.ts';
import { InMemoryGitHosting } from './in-memory-git-hosting.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';

// The fake login provider names each user's subject after the name they sign in with.
const SUBJECTS = new Map([PLATFORM_ADMIN, ...DEMO_MEMBERS].map((user) => [user.username, `fake|${user.username}`]));

const EXPECTED: Readonly<Record<string, { readonly role: string; readonly can: string[]; readonly cannot: string[] }>> = {
  'demo-company-admin': {
    role: 'company-admin',
    can: ['company-users:manage', 'applications:create'],
    cannot: ['releases:start', 'deployments-production:run'],
  },
  'demo-tech-lead': {
    role: 'tech-lead',
    can: ['applications:create', 'releases:start', 'deployments-production:run'],
    cannot: ['company-users:manage'],
  },
  'demo-developer': { role: 'developer', can: ['code:push', 'applications:test'], cannot: ['applications:create'] },
  'demo-operator': {
    role: 'operator',
    can: ['deployments-production:run', 'applications:run'],
    cannot: ['code:push', 'applications:create'],
  },
  'demo-viewer': { role: 'viewer', can: ['applications:view', 'dashboards:view'], cannot: ['applications:create', 'code:push'] },
};

let database: TestDatabase;
let appPool: pg.Pool;
let app: INestApplication;
let gitHosting: InMemoryGitHosting;

const signIn = async (user: string) => {
  const agent = request.agent(app.getHttpServer());
  const login = await agent.get(`/api/v1/auth/login?login_hint=${user}`).expect(302);
  const callback = new URL(login.headers.location as string);
  await agent.get(callback.pathname + callback.search).expect(302);
  return agent;
};

beforeAll(async () => {
  database = await startTestDatabase();
  appPool = new pg.Pool({ connectionString: database.urlFor('app') });
  gitHosting = new InMemoryGitHosting();
  app = await buildApp({
    config: { ...database.config(), secureCookies: false },
    overrides: [
      { provide: IDENTITY_PROVIDER, useValue: new FakeIdentityProvider() },
      { provide: GIT_HOSTING, useValue: gitHosting },
      { provide: JOB_QUEUE, useValue: new InMemoryJobQueue() },
      {
        provide: OUTBOX_RELAY,
        useFactory: (pool: pg.Pool, bus: EventBus) => new OutboxRelay(pool, bus, { pollIntervalMs: 50 }),
        inject: [RELAY_POOL, EventBus],
      },
    ],
  });
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await database?.stop();
});

describe('seeding the demo company', () => {
  let companyId: string;

  it('creates it with the API’s own access, and provisions it like any other', async () => {
    const result = await seedDemoCompany(appPool, SUBJECTS);

    expect(result.created).toBe(true);
    companyId = result.companyId;
    // Members get access once provisioning makes the company active.
    const admin = await signIn('demo-company-admin');
    const profile = await vi.waitFor(
      async () => {
        const response = await admin.get('/api/v1/company').expect(200);
        return response.body;
      },
      { timeout: 15_000, interval: 50 },
    );
    expect(profile).toMatchObject({
      name: DEMO_COMPANY.name,
      slug: DEMO_COMPANY.slug,
      status: 'active',
      resources: [{ kind: 'git-organization', status: 'ready', name: DEMO_COMPANY.slug }],
    });
    expect(gitHosting.displayNameOf(DEMO_COMPANY.slug)).toBe(DEMO_COMPANY.name);
  });

  it.each(Object.entries(EXPECTED))('lets %s sign in to it with their role, and only its permissions', async (username, expected) => {
    const agent = await signIn(username);

    const { body } = await agent.get('/api/v1/auth/me').expect(200);

    expect(body).toMatchObject({
      email: `${username}@example.com`,
      companyId,
      companyName: DEMO_COMPANY.name,
      role: expected.role,
    });
    for (const permission of expected.can) {
      expect(body.permissions).toContain(permission);
    }
    for (const permission of expected.cannot) {
      expect(body.permissions).not.toContain(permission);
    }
  });

  it('gives the Company Admin a team of one person in each role', async () => {
    const admin = await signIn('demo-company-admin');

    const { body } = await admin.get('/api/v1/company/members').expect(200);

    // In this order, from Company Admin to Viewer.
    expect((body as { email: string; role: string }[]).map(({ email, role }) => ({ email, role }))).toEqual(
      DEMO_MEMBERS.map((member) => ({ email: member.email, role: member.role })),
    );
  });

  it('changes nothing when it runs again, even after someone changed the company', async () => {
    const admin = await signIn('demo-company-admin');
    const members = await admin.get('/api/v1/company/members').expect(200);
    const viewer = (members.body as { userId: string; role: string }[]).find((member) => member.role === 'viewer')!;
    await admin.patch(`/api/v1/company/members/${viewer.userId}`).send({ role: 'developer' }).expect(204);

    await expect(seedDemoCompany(appPool, SUBJECTS)).resolves.toEqual({ created: false, companyId });

    const after = await admin.get('/api/v1/company/members').expect(200);
    expect(after.body).toHaveLength(DEMO_MEMBERS.length);
    expect((after.body as { userId: string; role: string }[]).find((member) => member.userId === viewer.userId)?.role).toBe(
      'developer',
    );
  });

  it('publishes what happened, with IDs only', async () => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
      const { rows } = await client.query<{ event_type: string; payload: object }>(
        'SELECT event_type, payload FROM kernel.outbox ORDER BY sequence',
      );
      await client.query('ROLLBACK');
      const types = rows.map((row) => row.event_type);
      expect(types[0]).toBe('CompanyCreated');
      // A role change made later publishes its own, which names the role before it.
      const seeded = rows.filter(
        (row) => row.event_type === 'RoleGranted' && !('previousRole' in (row.payload as Record<string, unknown>)),
      );
      expect(seeded.map((row) => (row.payload as { role: string }).role)).toEqual(DEMO_MEMBERS.map((member) => member.role));
      expect(JSON.stringify(rows)).not.toContain('@example.com');
    } finally {
      client.release();
    }
  });

  it('refuses to seed users the login provider does not know', async () => {
    const fresh = await startTestDatabase();
    const pool = new pg.Pool({ connectionString: fresh.urlFor('app') });
    try {
      await expect(seedDemoCompany(pool, new Map([[PLATFORM_ADMIN.username, 'fake|x']]))).rejects.toThrow(
        'The login provider has no user "demo-company-admin".',
      );
    } finally {
      await pool.end();
      await fresh.stop();
    }
  });
});
