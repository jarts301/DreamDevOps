import { Controller, Get, type INestApplication, Inject, Post } from '@nestjs/common';
import { createDomainEvent, currentCompanyId } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateApi } from '../src/database/migrate.ts';
import { type CodeExchange, IDENTITY_PROVIDER } from '../src/identity-access/application/ports.ts';
import { PostgresUserDirectory } from '../src/identity-access/infrastructure/postgres-user-directory.ts';
import { Authenticated, RequirePermissions } from '../src/http/access.decorators.ts';
import { PostgresSessionStore } from '../src/session/postgres-session-store.ts';
import { hashSessionId } from '../src/session/session-store.ts';
import { FakeIdentityProvider } from './fakes.ts';
import { describeSessionStoreContract } from './session-store-contract.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';
import { type Agent, signIn as signInAs } from './support/integration.ts';

@Controller('sample')
class SampleController {
  readonly #database: TenantDatabase;

  constructor(@Inject(TenantDatabase) database: TenantDatabase) {
    this.#database = database;
  }

  @Authenticated()
  @Post('events')
  async save(): Promise<object> {
    const event = createDomainEvent({ eventType: 'SampleCreated', companyId: currentCompanyId(), payload: {} });
    await this.#database.transaction((tx) => appendToOutbox(tx, [event]));
    return { eventId: event.eventId };
  }

  @Authenticated()
  @Get('events')
  async list(): Promise<object> {
    const eventIds = await this.#database.transaction(async (tx) => {
      const { rows } = await tx.query('SELECT event_id FROM kernel.outbox');
      return rows.map((row) => row.event_id as string);
    });
    return { eventIds };
  }

  @RequirePermissions('releases:start')
  @Get('start-release')
  startRelease(): object {
    return { ok: true };
  }

  @RequirePermissions('deployments-production:run')
  @Get('deploy-production')
  deployProduction(): object {
    return { ok: true };
  }
}

let database: TestDatabase;
let appPool: pg.Pool;
let ownerPool: pg.Pool;
let app: INestApplication;

const signIn = (user: string) => signInAs(app, user);

let companyCounter = 0;
const newCompany = () => {
  companyCounter += 1;
  return `10000000-0000-4000-8000-${String(companyCounter).padStart(12, '0')}`;
};

let userCounter = 0;
/** A new user name per test, so tests don't share memberships. */
const newName = (prefix: string) => {
  userCounter += 1;
  return `${prefix}-${'abcdefghijklmnopqrstuvwxyz'[Math.floor(userCounter / 26) % 26]}${'abcdefghijklmnopqrstuvwxyz'[userCounter % 26]}`;
};
const emailOf = (name: string) => `${name}@example.com`;

/** Creates a company with a signed-in admin, the way a real company starts. */
const startCompany = async () => {
  const platformAdmin = await signIn('platform-admin');
  const name = newName('admin');
  const { body } = await platformAdmin
    .post('/api/v1/platform/companies')
    .send({ name: `Company of ${name}`, firstAdminEmail: emailOf(name) })
    .expect(201);
  const admin = await signIn(name);
  await admin.post('/api/v1/invitations/accept').send({ token: body.invitation.token }).expect(200);
  return { companyId: body.company.id as string, admin, name };
};

/** Invites a new user into the admin's company with a role and signs them in. */
const addMember = async (admin: Agent, role: string) => {
  const name = newName('member');
  const { body } = await admin
    .post('/api/v1/company/invitations')
    .send({ email: emailOf(name), role })
    .expect(201);
  const member = await signIn(name);
  await member.post('/api/v1/invitations/accept').send({ token: body.token }).expect(200);
  const me = await member.get('/api/v1/auth/me').expect(200);
  return { agent: member, userId: me.body.userId as string, name };
};

beforeAll(async () => {
  database = await startTestDatabase();
  appPool = new pg.Pool({ connectionString: database.urlFor('app') });
  ownerPool = new pg.Pool({ connectionString: database.urlFor('owner') });
  app = await buildApp({
    controllers: [SampleController],
    config: { databaseUrl: database.urlFor('app'), secureCookies: false },
    overrides: [{ provide: IDENTITY_PROVIDER, useValue: new FakeIdentityProvider() }],
  });
});

afterAll(async () => {
  await app.close();
  await appPool.end();
  await ownerPool.end();
  await database.stop();
});

describeSessionStoreContract('PostgreSQL', () => ({
  store: new PostgresSessionStore(appPool),
  expire: async (idHash, limit) => {
    const column = limit === 'idle' ? 'idle_expires_at' : 'expires_at';
    await ownerPool.query(`UPDATE api.sessions SET ${column} = now() - interval '1 day' WHERE id_hash = $1`, [idHash]);
  },
  expiryTimes: async (idHash) => {
    const { rows } = await ownerPool.query<{ idle_expires_at: Date; expires_at: Date }>(
      'SELECT idle_expires_at, expires_at FROM api.sessions WHERE id_hash = $1',
      [idHash],
    );
    return { idle: rows[0]!.idle_expires_at.getTime(), absolute: rows[0]!.expires_at.getTime() };
  },
}));

describe('migrations and storage', () => {
  it('applies migrations only once', async () => {
    await expect(migrateApi(database.urlFor('owner'))).resolves.toEqual([]);
  });

  it('gives the application role no direct access to sessions or users', async () => {
    await expect(appPool.query('SELECT * FROM api.sessions')).rejects.toThrow('permission denied');
    await expect(appPool.query('SELECT * FROM identity.users')).rejects.toThrow('permission denied');
  });

  it('shows no memberships or invitations without a company', async () => {
    await startCompany();

    await expect(appPool.query('SELECT * FROM identity.memberships')).resolves.toMatchObject({ rows: [] });
    await expect(appPool.query('SELECT * FROM identity.invitations')).resolves.toMatchObject({ rows: [] });
  });

  it('stores only a hash of the session ID', async () => {
    const server = app.getHttpServer();
    const login = await request(server).get('/api/v1/auth/login?login_hint=hash-check');
    const loginCookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const callback = new URL(login.headers.location as string);
    const finished = await request(server).get(callback.pathname + callback.search).set('Cookie', loginCookie);
    const sessionId = (finished.headers['set-cookie'] as unknown as string[])
      .find((cookie) => cookie.startsWith('dd_session='))!
      .split(';')[0]!
      .slice('dd_session='.length);

    const raw = await ownerPool.query('SELECT 1 FROM api.sessions WHERE id_hash = $1', [sessionId]);
    const hashed = await ownerPool.query('SELECT 1 FROM api.sessions WHERE id_hash = $1', [hashSessionId(sessionId)]);

    expect(raw.rows).toEqual([]);
    expect(hashed.rows).toHaveLength(1);
  });

  it('removes expired sessions when a new one is created', async () => {
    const store = new PostgresSessionStore(appPool);
    const data = { userId: 'u', chosenCompanyId: null, idToken: null };
    await store.create('short-lived', data, { absoluteMs: 60_000, idleMs: 60_000 });
    await ownerPool.query("UPDATE api.sessions SET expires_at = now() - interval '1 day' WHERE id_hash = 'short-lived'");

    await store.create('fresh', data, { absoluteMs: 60_000, idleMs: 60_000 });

    const { rows } = await ownerPool.query("SELECT 1 FROM api.sessions WHERE id_hash = 'short-lived'");
    expect(rows).toEqual([]);
  });
});

describe('user directory', () => {
  const external = {
    subject: 'directory|one',
    email: 'one@example.com',
    emailVerified: true,
    displayName: 'One',
    platformAdmin: false,
    idToken: null,
    mfa: true,
  };

  it('creates a user once and updates them on later logins', async () => {
    const directory = new PostgresUserDirectory(appPool);

    const first = await directory.recordLogin(external);
    const second = await directory.recordLogin({ ...external, displayName: 'Renamed', email: 'new@example.com' });

    expect(second).toBe(first);
    await expect(directory.loadAccess(first)).resolves.toMatchObject({
      displayName: 'Renamed',
      email: 'new@example.com',
      memberships: [],
      platformPermissions: [],
    });
  });

  it('removes platform access when the login provider no longer grants it', async () => {
    const directory = new PostgresUserDirectory(appPool);
    const id = await directory.recordLogin({ ...external, subject: 'directory|admin', platformAdmin: true });
    await expect(directory.loadAccess(id)).resolves.toMatchObject({
      platformPermissions: ['audit:read-own', 'companies:manage', 'editions:manage'],
    });

    await directory.recordLogin({ ...external, subject: 'directory|admin', platformAdmin: false });

    await expect(directory.loadAccess(id)).resolves.toMatchObject({ platformPermissions: [] });
  });

  it('returns null for an unknown user', async () => {
    await expect(new PostgresUserDirectory(appPool).loadAccess('00000000-0000-4000-8000-000000000000')).resolves.toBeNull();
  });
});

describe('the role matrix', () => {
  // The proposal's permission matrix, written out independently of the migration.
  const MATRIX: Record<string, string[]> = {
    'company-admin': [
      'applications:create',
      'audit:read',
      'company-users:manage',
      'dashboards:view',
      'notifications:manage',
      'targets:connect',
      'test-environment-config:manage',
    ],
    developer: ['code:push', 'dashboards:view', 'deployments-test:run', 'feature-images:build'],
    operator: [
      'dashboards:view',
      'deployments-production:run',
      'deployments-test:run',
      'environment-config:manage',
      'targets:connect',
      'test-environment-config:manage',
    ],
    'tech-lead': [
      'applications:create',
      'code:push',
      'dashboards:view',
      'deployments-production:run',
      'deployments-test:run',
      'environment-config:manage',
      'feature-images:build',
      'pull-requests:approve',
      'releases:start',
      'test-environment-config:manage',
    ],
    viewer: ['dashboards:view'],
  };

  it('offers exactly the company roles and permissions in the proposal', async () => {
    const { admin } = await startCompany();

    const { body } = await admin.get('/api/v1/company/roles').expect(200);

    const roles = Object.fromEntries(
      (body as { key: string; permissions: string[] }[]).map((role) => [role.key, role.permissions]),
    );
    expect(roles).toEqual(MATRIX);
  });

  it.each([
    ['tech-lead', 200, 200],
    ['operator', 403, 200],
    ['developer', 403, 403],
    ['viewer', 403, 403],
  ])('applies the permissions of %s', async (role, releaseStatus, productionStatus) => {
    const { admin } = await startCompany();
    const member = await addMember(admin, role);

    await member.agent.get('/api/v1/sample/start-release').expect(releaseStatus);
    await member.agent.get('/api/v1/sample/deploy-production').expect(productionStatus);
  });

  it('gives a Company Admin no release or deployment rights', async () => {
    const { admin } = await startCompany();

    await admin.get('/api/v1/sample/start-release').expect(403);
    await admin.get('/api/v1/sample/deploy-production').expect(403);
  });
});

describe('invitations', () => {
  it('turns an accepted invitation into a membership', async () => {
    const { admin, companyId } = await startCompany();

    const member = await addMember(admin, 'developer');

    const { body } = await member.agent.get('/api/v1/auth/me').expect(200);
    expect(body).toMatchObject({ companyId, role: 'developer' });
    expect(body.permissions).toContain('code:push');
  });

  it('never stores or lists the token', async () => {
    const { admin } = await startCompany();
    const name = newName('invited');
    const { body } = await admin.post('/api/v1/company/invitations').send({ email: emailOf(name), role: 'viewer' });

    const listed = await admin.get('/api/v1/company/invitations').expect(200);
    const stored = await ownerPool.query('SELECT token_hash FROM identity.invitations WHERE id = $1', [body.id]);

    expect(JSON.stringify(listed.body)).not.toContain(body.token);
    expect(listed.body[0]).not.toHaveProperty('token');
    expect(stored.rows[0].token_hash).not.toBe(body.token);
  });

  it('refuses a token used by a different person', async () => {
    const { admin } = await startCompany();
    const { body } = await admin
      .post('/api/v1/company/invitations')
      .send({ email: emailOf(newName('intended')), role: 'viewer' });
    const stranger = await signIn(newName('stranger'));

    await stranger.post('/api/v1/invitations/accept').send({ token: body.token }).expect(404);

    const me = await stranger.get('/api/v1/auth/me').expect(200);
    expect(me.body.companyId).toBeNull();
  });

  it('accepts an invitation only once', async () => {
    const { admin } = await startCompany();
    const name = newName('once');
    const { body } = await admin.post('/api/v1/company/invitations').send({ email: emailOf(name), role: 'viewer' });
    const member = await signIn(name);

    await member.post('/api/v1/invitations/accept').send({ token: body.token }).expect(200);

    await member.post('/api/v1/invitations/accept').send({ token: body.token }).expect(404);
  });

  it('refuses a revoked invitation', async () => {
    const { admin } = await startCompany();
    const name = newName('revoked');
    const { body } = await admin.post('/api/v1/company/invitations').send({ email: emailOf(name), role: 'viewer' });
    await admin.delete(`/api/v1/company/invitations/${body.id}`).expect(204);
    const member = await signIn(name);

    await member.post('/api/v1/invitations/accept').send({ token: body.token }).expect(404);
  });

  it('refuses an expired invitation, and allows a new one', async () => {
    const { admin } = await startCompany();
    const name = newName('expired');
    const { body } = await admin.post('/api/v1/company/invitations').send({ email: emailOf(name), role: 'viewer' });
    await ownerPool.query("UPDATE identity.invitations SET expires_at = now() - interval '1 day' WHERE id = $1", [
      body.id,
    ]);
    const member = await signIn(name);

    await member.post('/api/v1/invitations/accept').send({ token: body.token }).expect(404);

    await admin.post('/api/v1/company/invitations').send({ email: emailOf(name), role: 'viewer' }).expect(201);
  });

  it('refuses a made-up token', async () => {
    const stranger = await signIn(newName('guesser'));

    await stranger.post('/api/v1/invitations/accept').send({ token: 'made-up' }).expect(404);
    await stranger.post('/api/v1/invitations/accept').send({}).expect(404);
  });

  it('requires signing in to accept', async () => {
    await request(app.getHttpServer()).post('/api/v1/invitations/accept').send({ token: 'anything' }).expect(401);
  });

  it('refuses a second open invitation for the same person', async () => {
    const { admin } = await startCompany();
    const email = emailOf(newName('twice'));
    await admin.post('/api/v1/company/invitations').send({ email, role: 'viewer' }).expect(201);

    await admin.post('/api/v1/company/invitations').send({ email, role: 'developer' }).expect(409);
  });

  it('refuses inviting someone who is already a member', async () => {
    const { admin } = await startCompany();
    const member = await addMember(admin, 'viewer');

    await admin.post('/api/v1/company/invitations').send({ email: emailOf(member.name), role: 'viewer' }).expect(409);
  });

  it.each(['platform-admin', 'no-such-role', '', undefined])('refuses inviting with the role %j', async (role) => {
    const { admin } = await startCompany();

    await admin.post('/api/v1/company/invitations').send({ email: emailOf(newName('role')), role }).expect(400);
  });

  it('refuses an invalid email address', async () => {
    const { admin } = await startCompany();

    await admin.post('/api/v1/company/invitations').send({ email: 'not-an-email', role: 'viewer' }).expect(400);
  });

  it('matches email addresses regardless of case', async () => {
    const { admin } = await startCompany();
    const name = newName('case');
    const { body } = await admin
      .post('/api/v1/company/invitations')
      .send({ email: emailOf(name).toUpperCase(), role: 'viewer' })
      .expect(201);
    const member = await signIn(name);

    await member.post('/api/v1/invitations/accept').send({ token: body.token }).expect(200);
  });
});

describe('managing members', () => {
  it('lists members of the current company only', async () => {
    const companyA = await startCompany();
    const companyB = await startCompany();
    const memberA = await addMember(companyA.admin, 'developer');

    const seenByA = await companyA.admin.get('/api/v1/company/members').expect(200);
    const seenByB = await companyB.admin.get('/api/v1/company/members').expect(200);

    const emails = (members: { email: string }[]) => members.map((member) => member.email);
    expect(emails(seenByA.body)).toContain(emailOf(memberA.name));
    expect(emails(seenByB.body)).not.toContain(emailOf(memberA.name));
    expect(emails(seenByB.body)).toEqual([emailOf(companyB.name)]);
  });

  it('applies a role change on the very next request', async () => {
    const { admin } = await startCompany();
    const member = await addMember(admin, 'viewer');
    await member.agent.get('/api/v1/sample/start-release').expect(403);

    await admin.patch(`/api/v1/company/members/${member.userId}`).send({ role: 'tech-lead' }).expect(204);

    await member.agent.get('/api/v1/sample/start-release').expect(200);
  });

  it('removes access on the very next request', async () => {
    const { admin } = await startCompany();
    const member = await addMember(admin, 'tech-lead');
    await member.agent.get('/api/v1/sample/start-release').expect(200);

    await admin.delete(`/api/v1/company/members/${member.userId}`).expect(204);

    await member.agent.get('/api/v1/sample/start-release').expect(403);
    const me = await member.agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.companyId).toBeNull();
  });

  it('refuses granting a platform role', async () => {
    const { admin } = await startCompany();
    const member = await addMember(admin, 'viewer');

    await admin.patch(`/api/v1/company/members/${member.userId}`).send({ role: 'platform-admin' }).expect(400);
  });

  it('keeps at least one Company Admin', async () => {
    const { admin } = await startCompany();
    const me = await admin.get('/api/v1/auth/me').expect(200);

    await admin.patch(`/api/v1/company/members/${me.body.userId}`).send({ role: 'viewer' }).expect(409);
    await admin.delete(`/api/v1/company/members/${me.body.userId}`).expect(409);

    await admin.get('/api/v1/company/members').expect(200);
  });

  it('allows an admin to step down once another admin exists', async () => {
    const { admin } = await startCompany();
    const me = await admin.get('/api/v1/auth/me').expect(200);
    await addMember(admin, 'company-admin');

    await admin.patch(`/api/v1/company/members/${me.body.userId}`).send({ role: 'viewer' }).expect(204);

    await admin.get('/api/v1/company/members').expect(403);
  });

  it('never loses the last admin when two admins remove each other at once', async () => {
    const { admin } = await startCompany();
    const first = await admin.get('/api/v1/auth/me').expect(200);
    const other = await addMember(admin, 'company-admin');

    const results = await Promise.all([
      admin.delete(`/api/v1/company/members/${other.userId}`),
      other.agent.delete(`/api/v1/company/members/${first.body.userId}`),
    ]);

    const statuses = results.map((result) => result.status);
    expect(statuses).toContain(204);
    const { rows } = await ownerPool.query(
      "SELECT count(*)::int AS admins FROM identity.memberships WHERE role_key = 'company-admin' AND user_id = ANY($1)",
      [[first.body.userId, other.userId]],
    );
    expect(rows[0].admins).toBeGreaterThanOrEqual(1);
  });

  it('cannot reach a member of another company', async () => {
    const companyA = await startCompany();
    const companyB = await startCompany();
    const memberB = await addMember(companyB.admin, 'developer');

    await companyA.admin.patch(`/api/v1/company/members/${memberB.userId}`).send({ role: 'viewer' }).expect(404);
    await companyA.admin.delete(`/api/v1/company/members/${memberB.userId}`).expect(404);

    const { rows } = await ownerPool.query('SELECT role_key FROM identity.memberships WHERE user_id = $1', [
      memberB.userId,
    ]);
    expect(rows).toEqual([{ role_key: 'developer' }]);
  });

  it("cannot revoke another company's invitation", async () => {
    const companyA = await startCompany();
    const companyB = await startCompany();
    const { body } = await companyB.admin
      .post('/api/v1/company/invitations')
      .send({ email: emailOf(newName('other')), role: 'viewer' });

    await companyA.admin.delete(`/api/v1/company/invitations/${body.id}`).expect(404);
  });

  it.each(['viewer', 'developer', 'tech-lead', 'operator'])('refuses member management to a %s', async (role) => {
    const { admin } = await startCompany();
    const member = await addMember(admin, role);

    await member.agent.get('/api/v1/company/members').expect(403);
    await member.agent.post('/api/v1/company/invitations').send({ email: 'x@example.com', role: 'viewer' }).expect(403);
  });

  it('rejects a malformed user ID', async () => {
    const { admin } = await startCompany();

    await admin.delete("/api/v1/company/members/'; DROP TABLE identity.users; --").expect(400);
  });
});

describe('several companies', () => {
  const joinTwoCompanies = async () => {
    const companyA = await startCompany();
    const companyB = await startCompany();
    const name = newName('consultant');
    const tokenA = await companyA.admin
      .post('/api/v1/company/invitations')
      .send({ email: emailOf(name), role: 'viewer' });
    const tokenB = await companyB.admin
      .post('/api/v1/company/invitations')
      .send({ email: emailOf(name), role: 'tech-lead' });
    const consultant = await signIn(name);
    await consultant.post('/api/v1/invitations/accept').send({ token: tokenA.body.token }).expect(200);
    await consultant.post('/api/v1/invitations/accept').send({ token: tokenB.body.token }).expect(200);
    return { consultant, companyA, companyB };
  };

  it('starts in the oldest company and switches on request', async () => {
    const { consultant, companyA, companyB } = await joinTwoCompanies();

    await expect(consultant.get('/api/v1/auth/me')).resolves.toMatchObject({
      body: { companyId: companyA.companyId, role: 'viewer' },
    });
    await consultant.get('/api/v1/sample/start-release').expect(403);

    await consultant.post('/api/v1/auth/active-company').send({ companyId: companyB.companyId }).expect(204);

    await expect(consultant.get('/api/v1/auth/me')).resolves.toMatchObject({
      body: { companyId: companyB.companyId, role: 'tech-lead' },
    });
    await consultant.get('/api/v1/sample/start-release').expect(200);
  });

  it('refuses switching to a company the user is not in', async () => {
    const { consultant } = await joinTwoCompanies();
    const elsewhere = await startCompany();

    await consultant.post('/api/v1/auth/active-company').send({ companyId: elsewhere.companyId }).expect(403);
  });

  it("sees only the active company's data through row-level security", async () => {
    const { consultant, companyA, companyB } = await joinTwoCompanies();
    const inA = await consultant.post('/api/v1/sample/events').expect(201);

    await consultant.post('/api/v1/auth/active-company').send({ companyId: companyB.companyId }).expect(204);
    const inB = await consultant.post('/api/v1/sample/events').expect(201);
    const seenInB = await consultant.get('/api/v1/sample/events').expect(200);

    expect(seenInB.body.eventIds).toContain(inB.body.eventId);
    expect(seenInB.body.eventIds).not.toContain(inA.body.eventId);
    expect(companyA.companyId).not.toBe(companyB.companyId);
  });
});

describe('platform admins', () => {
  it('can invite the first admin of an empty company only', async () => {
    const { companyId } = await startCompany();
    const platformAdmin = await signIn('platform-admin');

    await platformAdmin
      .post(`/api/v1/platform/companies/${companyId}/first-admin-invitation`)
      .send({ email: 'intruder@example.com' })
      .expect(409);
    await platformAdmin
      .post(`/api/v1/platform/companies/${newCompany()}/first-admin-invitation`)
      .send({ email: 'intruder@example.com' })
      .expect(404);
  });

  it('get no access to company data', async () => {
    await startCompany();
    const platformAdmin = await signIn('platform-admin');

    await platformAdmin.get('/api/v1/company/members').expect(403);
    await platformAdmin.get('/api/v1/sample/events').expect(403);
    const { body } = await platformAdmin.get('/api/v1/auth/me').expect(200);
    expect(body.companyId).toBeNull();
  });

  it('are the only ones who can start a company', async () => {
    const { admin } = await startCompany();

    await admin.post('/api/v1/platform/companies').send({ name: 'Sneaky', firstAdminEmail: 'x@example.com' }).expect(403);
  });
});

describe('events', () => {
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

  it('publishes each change through the outbox, with no tokens or emails', async () => {
    const { admin, companyId } = await startCompany();
    const member = await addMember(admin, 'viewer');
    await admin.patch(`/api/v1/company/members/${member.userId}`).send({ role: 'developer' }).expect(204);
    await admin.delete(`/api/v1/company/members/${member.userId}`).expect(204);

    const events = await eventsOf(companyId);

    expect(events.map((event) => event.event_type)).toEqual([
      'CompanyCreated',
      'UserInvited',
      'RoleGranted',
      'UserInvited',
      'RoleGranted',
      'RoleGranted',
      'MemberRemoved',
    ]);
    expect(JSON.stringify(events)).not.toContain('@example.com');
  });
});

describe('logout', () => {
  it('ends the session and returns where to end the login provider session', async () => {
    const agent = await signIn(newName('leaving'));

    const { body } = await agent.post('/api/v1/auth/logout').expect(200);

    expect(body.logoutUrl).toContain('id-token-of-leaving');
    await agent.get('/api/v1/auth/me').expect(401);
  });
});

describe('verified email', () => {
  class UnverifiedIdentityProvider extends FakeIdentityProvider {
    override async exchangeCode(exchange: CodeExchange) {
      const identity = await super.exchangeCode(exchange);
      return identity && { ...identity, emailVerified: false };
    }
  }

  it('refuses an invitation until the email is verified', async () => {
    const strictApp = await buildApp({
      config: { databaseUrl: database.urlFor('app'), secureCookies: false, requireVerifiedEmail: true },
      overrides: [{ provide: IDENTITY_PROVIDER, useValue: new UnverifiedIdentityProvider() }],
    });
    try {
      const { admin } = await startCompany();
      const name = newName('unverified');
      const { body } = await admin.post('/api/v1/company/invitations').send({ email: emailOf(name), role: 'viewer' });
      const agent = request.agent(strictApp.getHttpServer());
      const login = await agent.get(`/api/v1/auth/login?login_hint=${name}`);
      const callback = new URL(login.headers.location as string);
      await agent.get(callback.pathname + callback.search).expect(302);

      await agent.post('/api/v1/invitations/accept').send({ token: body.token }).expect(400);
    } finally {
      await strictApp.close();
    }
  });
});

describe('a second factor', () => {
  /** Signs in following every redirect, including a step-up for a second factor. */
  const signInFully = async (user: string) => {
    const agent = request.agent(app.getHttpServer());
    let next = `/api/v1/auth/login?login_hint=${user}`;
    for (let step = 0; step < 6; step += 1) {
      const response = await agent.get(next).expect(302);
      const location = new URL(response.headers.location as string, 'http://api.test');
      if (!location.pathname.startsWith('/api/v1/auth/')) {
        return agent;
      }
      next = location.pathname + location.search;
    }
    throw new Error('Too many redirects.');
  };

  it('is needed at once when a member becomes a Tech Lead, and signing in again with one works', async () => {
    const { admin } = await startCompany();
    const name = newName('nomfa-member');
    const { body } = await admin.post('/api/v1/company/invitations').send({ email: emailOf(name), role: 'developer' }).expect(201);
    const member = await signIn(name);
    await member.post('/api/v1/invitations/accept').send({ token: body.token }).expect(200);
    const me = await member.get('/api/v1/auth/me').expect(200);

    await admin.patch(`/api/v1/company/members/${me.body.userId}`).send({ role: 'tech-lead' }).expect(204);

    // The session has no second factor, so it no longer counts as signed in.
    await member.get('/api/v1/auth/me').expect(401);
    const again = await signInFully(name);
    await expect(again.get('/api/v1/auth/me').expect(200)).resolves.toMatchObject({ body: { role: 'tech-lead' } });
  });
});
