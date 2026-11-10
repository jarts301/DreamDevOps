import { generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TargetAgents } from '../src/environments/application/target-agents.ts';
import { IDENTITY_PROVIDER } from '../src/identity-access/application/ports.ts';
import { GIT_PROVIDER } from '../src/tenancy/application/ports.ts';
import { FakeGitProvider, FakeIdentityProvider } from './fakes.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';

const TOKEN_URL = 'http://api.test/api/v1/agent/token';

let database: TestDatabase;
let superuser: pg.Pool;
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
  return { admin, companyId: body.company.id as string };
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

const createEnvironment = async (admin: Agent, kind: 'test' | 'production' = 'test', extra: object = {}) =>
  (await admin.post('/api/v1/company/environments').send({ name: unique('Env'), kind, ...extra }).expect(201))
    .body as { id: string; name: string; slug: string };

/** Plays the agent in a target: it makes its own key pair and only calls out. */
class SimulatedAgent {
  readonly #privateKey: KeyObject;
  readonly x: string;
  targetId = '';
  accessToken = '';

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.#privateKey = privateKey;
    this.x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  }

  register(registrationToken: string) {
    return request(app.getHttpServer())
      .post('/api/v1/agent/register')
      .send({
        registrationToken,
        publicKey: { kty: 'OKP', crv: 'Ed25519', x: this.x },
        agentVersion: '0.1.0',
        kubernetesVersion: 'v1.31.2+k3s1',
      });
  }

  assertion(claims: Record<string, unknown> = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'EdDSA', typ: 'JWT' });
    const payload = encode({
      iss: this.targetId,
      sub: this.targetId,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 60,
      jti: randomBytes(16).toString('base64url'),
      ...claims,
    });
    return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), this.#privateKey).toString('base64url')}`;
  }

  token(assertion = this.assertion()) {
    return request(app.getHttpServer()).post('/api/v1/agent/token').send({ assertion });
  }

  heartbeat(token = this.accessToken) {
    return request(app.getHttpServer())
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send({ agentVersion: '0.1.1' });
  }

  /** Registers with the token from the dashboard, then gets an access token. */
  async connect(registrationToken: string): Promise<this> {
    const { body } = await this.register(registrationToken).expect(201);
    this.targetId = body.targetId;
    this.accessToken = (await this.token().expect(200)).body.accessToken;
    return this;
  }
}

const connectTarget = async (admin: Agent, environmentId: string) => {
  const { body } = await admin.post(`/api/v1/company/environments/${environmentId}/target`).expect(201);
  return new SimulatedAgent().connect(body.registrationToken);
};

const auditTypes = async (admin: Agent) =>
  ((await admin.get('/api/v1/company/audit').expect(200)).body.entries as { eventType: string }[]).map(
    (entry) => entry.eventType,
  );

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

describe('environments', () => {
  it('are created by Company Admins and Operators, and seen by every member', async () => {
    const { admin } = await createCompany();
    const operator = await addMember(admin, 'operator');
    const developer = await addMember(admin, 'developer');

    const test = await createEnvironment(admin, 'test');
    const production = await createEnvironment(operator, 'production');
    await developer.post('/api/v1/company/environments').send({ name: 'Mine', kind: 'test' }).expect(403);

    const { body } = await developer.get('/api/v1/company/environments').expect(200);
    expect(body.map((environment: { id: string }) => environment.id)).toEqual([production.id, test.id]);
    expect(body[0]).toMatchObject({ kind: 'production', acceptsFeatureImages: false, acceptedImages: ['final'], target: null });
    expect(body[1]).toMatchObject({ kind: 'test', acceptedImages: ['feature', 'rc', 'final'] });
  });

  it('keep feature images out of production, and names unique', async () => {
    const { admin } = await createCompany();
    const { body: refused } = await admin
      .post('/api/v1/company/environments')
      .send({ name: 'Live', kind: 'production', acceptsFeatureImages: true })
      .expect(400);
    expect(refused.detail).toBe('Production accepts final images only.');

    const rcTesting = await createEnvironment(admin, 'test', { acceptsFeatureImages: false });
    expect((await admin.get(`/api/v1/company/environments/${rcTesting.id}`).expect(200)).body.acceptedImages).toEqual([
      'rc',
      'final',
    ]);
    await admin.post('/api/v1/company/environments').send({ name: rcTesting.name.toUpperCase(), kind: 'test' }).expect(409);

    await admin.patch(`/api/v1/company/environments/${rcTesting.id}`).send({ acceptsFeatureImages: true }).expect(204);
    expect((await admin.get(`/api/v1/company/environments/${rcTesting.id}`).expect(200)).body.acceptsFeatureImages).toBe(true);
  });

  it("can't be seen or changed by another company", async () => {
    const first = await createCompany();
    const second = await createCompany();
    const environment = await createEnvironment(first.admin);

    await second.admin.get(`/api/v1/company/environments/${environment.id}`).expect(404);
    await second.admin.post(`/api/v1/company/environments/${environment.id}/target`).expect(404);
    expect((await second.admin.get('/api/v1/company/environments').expect(200)).body).toEqual([]);
  });
});

describe('connecting a target', () => {
  it('gives a one-time token in a Helm command, which the agent swaps for its own key', async () => {
    const { admin } = await createCompany();
    const environment = await createEnvironment(admin, 'production');

    const { body: connection } = await admin.post(`/api/v1/company/environments/${environment.id}/target`).expect(201);
    expect(connection.command).toContain('helm upgrade --install dreamdevops-agent oci://charts.test/dreamdevops-agent');
    expect(connection.command).toContain(`--set registrationToken=${connection.registrationToken}`);
    expect(connection.command).toContain('--set platformUrl=http://api.test');
    const pending = (await admin.get(`/api/v1/company/environments/${environment.id}`).expect(200)).body.target;
    expect(pending).toMatchObject({ status: 'pending', registrationExpiresAt: connection.expiresAt });

    const agent = new SimulatedAgent();
    const { body: registration } = await agent.register(connection.registrationToken).expect(201);
    expect(registration).toEqual({
      targetId: connection.targetId,
      tokenUrl: TOKEN_URL,
      heartbeatSeconds: 30,
      environment: {
        id: environment.id,
        name: environment.name,
        slug: environment.slug,
        kind: 'production',
        acceptedImages: ['final'],
      },
    });
    // The token works once.
    await new SimulatedAgent().register(connection.registrationToken).expect(401);

    const { body } = await admin.get(`/api/v1/company/environments/${environment.id}`).expect(200);
    expect(body.target).toMatchObject({
      id: connection.targetId,
      status: 'connected',
      agentVersion: '0.1.0',
      kubernetesVersion: 'v1.31.2+k3s1',
      keyFingerprint: expect.stringMatching(/^[0-9a-f]{4}(:[0-9a-f]{4}){3}$/),
      registrationExpiresAt: null,
    });
    await eventually(async () =>
      expect(await auditTypes(admin)).toEqual(expect.arrayContaining(['TargetRegistrationStarted', 'TargetConnected'])),
    );
  });

  it('refuses expired, wrong and replaced registration tokens', async () => {
    const { admin } = await createCompany();
    const environment = await createEnvironment(admin);
    const connect = async () =>
      (await admin.post(`/api/v1/company/environments/${environment.id}/target`).expect(201)).body as {
        targetId: string;
        registrationToken: string;
      };

    const replaced = await connect();
    const current = await connect();
    await new SimulatedAgent().register(replaced.registrationToken).expect(401);

    await superuser.query(
      "UPDATE environments.targets SET registration_expires_at = now() - interval '1 minute' WHERE id = $1",
      [current.targetId],
    );
    const { body } = await new SimulatedAgent().register(current.registrationToken).expect(401);
    expect(body.detail).toBe('This registration token is not valid.');
    await new SimulatedAgent().register(`${current.targetId}.${'a'.repeat(43)}`).expect(401);
    await new SimulatedAgent().register('nonsense').expect(401);
  });

  it('allows one target per environment', async () => {
    const { admin } = await createCompany();
    const environment = await createEnvironment(admin);
    await connectTarget(admin, environment.id);

    const { body } = await admin.post(`/api/v1/company/environments/${environment.id}/target`).expect(409);
    expect(body.detail).toBe('This environment already has a target. Disconnect it first.');
  });
});

describe('a connected agent', () => {
  it('gets short-lived access tokens with assertions signed by its own key, each used once', async () => {
    const { admin } = await createCompany();
    const agent = await connectTarget(admin, (await createEnvironment(admin)).id);

    const assertion = agent.assertion();
    const { body } = await agent.token(assertion).expect(200);
    expect(body).toEqual({ accessToken: expect.stringMatching(new RegExp(`^${agent.targetId}\\.`)), expiresIn: 900 });
    await agent.token(assertion).expect(401);

    // An assertion signed with any other key, or for another address, is refused.
    const impostor = new SimulatedAgent();
    impostor.targetId = agent.targetId;
    await impostor.token().expect(401);
    await agent.token(agent.assertion({ aud: 'http://elsewhere/api/v1/agent/token' })).expect(401);
  });

  it('reports in with its access token, and only the newest token works', async () => {
    const { admin } = await createCompany();
    const environment = await createEnvironment(admin);
    const agent = await connectTarget(admin, environment.id);
    const first = agent.accessToken;

    expect((await agent.heartbeat().expect(200)).body).toEqual({ heartbeatSeconds: 30 });
    expect((await admin.get(`/api/v1/company/environments/${environment.id}`).expect(200)).body.target.agentVersion).toBe(
      '0.1.1',
    );

    agent.accessToken = (await agent.token().expect(200)).body.accessToken;
    await agent.heartbeat(first).expect(401);
    await agent.heartbeat().expect(200);
    await agent.heartbeat('nonsense').expect(401);
  });

  it('is marked as lost when it stops reporting, and connected again when it reports', async () => {
    const { admin } = await createCompany();
    const environment = await createEnvironment(admin);
    const agent = await connectTarget(admin, environment.id);
    await superuser.query("UPDATE environments.targets SET last_seen_at = now() - interval '10 minutes' WHERE id = $1", [
      agent.targetId,
    ]);

    await app.get(TargetAgents).markSilentTargetsLost();
    expect((await admin.get(`/api/v1/company/environments/${environment.id}`).expect(200)).body.target.status).toBe('lost');

    await agent.heartbeat().expect(200);
    expect((await admin.get(`/api/v1/company/environments/${environment.id}`).expect(200)).body.target.status).toBe(
      'connected',
    );
    await eventually(async () => {
      const types = await auditTypes(admin);
      expect(types).toContain('TargetLost');
      expect(types.filter((type) => type === 'TargetConnected')).toHaveLength(2);
    });
  });

  it('is cut off at once when disconnected, and a new target can then connect', async () => {
    const { admin } = await createCompany();
    const environment = await createEnvironment(admin);
    const agent = await connectTarget(admin, environment.id);
    const developer = await addMember(admin, 'developer');
    await developer.delete(`/api/v1/company/environments/${environment.id}/target`).expect(403);

    await admin.delete(`/api/v1/company/environments/${environment.id}/target`).expect(204);

    await agent.heartbeat().expect(401);
    await agent.token().expect(401);
    expect((await admin.get(`/api/v1/company/environments/${environment.id}`).expect(200)).body.target).toBeNull();
    const replacement = await connectTarget(admin, environment.id);
    await replacement.heartbeat().expect(200);
    await eventually(async () => expect(await auditTypes(admin)).toContain('TargetRevoked'));
  });
});

describe('archiving an environment', () => {
  it('needs its target disconnected first', async () => {
    const { admin } = await createCompany();
    const environment = await createEnvironment(admin);
    await connectTarget(admin, environment.id);

    const { body } = await admin.post(`/api/v1/company/environments/${environment.id}/archive`).expect(409);
    expect(body.detail).toBe('Disconnect its target first.');

    await admin.delete(`/api/v1/company/environments/${environment.id}/target`).expect(204);
    await admin.post(`/api/v1/company/environments/${environment.id}/archive`).expect(204);
    expect((await admin.get('/api/v1/company/environments?status=archived').expect(200)).body).toHaveLength(1);
    await admin.post(`/api/v1/company/environments/${environment.id}/target`).expect(409);
    await admin.post(`/api/v1/company/environments/${environment.id}/restore`).expect(204);
  });
});
