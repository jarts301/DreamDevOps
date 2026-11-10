import { generateKeyPairSync, type KeyObject, randomBytes, randomUUID, sign } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { ENVIRONMENT_REPOSITORIES, SECRET_STORE } from '../src/environments/application/ports.ts';
import { IDENTITY_PROVIDER } from '../src/identity-access/application/ports.ts';
import { GIT_PROVIDER } from '../src/tenancy/application/ports.ts';
import { FakeEnvironmentRepositories, FakeGitProvider, FakeIdentityProvider, FakeSecretStore } from './fakes.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';

const TOKEN_URL = 'http://api.test/api/v1/agent/token';

let database: TestDatabase;
let superuser: pg.Pool;
let app: INestApplication;
let repositories: FakeEnvironmentRepositories;
let secrets: FakeSecretStore;

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

/** Plays the agent in a target. */
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

  async connect(registrationToken: string): Promise<this> {
    const server = app.getHttpServer();
    const { body } = await request(server)
      .post('/api/v1/agent/register')
      .send({ registrationToken, publicKey: { kty: 'OKP', crv: 'Ed25519', x: this.x } })
      .expect(201);
    this.targetId = body.targetId;
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'EdDSA', typ: 'JWT' });
    const payload = encode({ iss: this.targetId, sub: this.targetId, aud: TOKEN_URL, iat: now, exp: now + 60, jti: randomBytes(16).toString('base64url') });
    const assertion = `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), this.#privateKey).toString('base64url')}`;
    this.accessToken = (await request(server).post('/api/v1/agent/token').send({ assertion }).expect(200)).body.accessToken;
    return this;
  }

  call(method: 'get' | 'put' | 'post', path: string) {
    return request(app.getHttpServer())[method](`/api/v1/agent${path}`).set('Authorization', `Bearer ${this.accessToken}`);
  }

  /** Reports how deployments are doing, and gets back the commands waiting. */
  async heartbeat(workloads: object[] = [], sync: object | null = null): Promise<{ id: string; action: string; namespace: string }[]> {
    return (await this.call('post', '/heartbeat').send({ agentVersion: '0.1.3', sync, workloads }).expect(200)).body.commands;
  }
}

const workload = (deploymentId: string, phase: string, ready = 2) => ({
  deploymentId,
  namespace: 'billing-api',
  name: 'billing-api',
  kind: 'Rollout',
  phase,
  desired: 2,
  updated: ready,
  ready,
  available: ready,
  message: phase === 'Degraded' ? 'ProgressDeadlineExceeded' : null,
});

interface Setup {
  admin: Agent;
  techLead: Agent;
  otherTechLead: Agent;
  developer: Agent;
  operator: Agent;
  companyId: string;
  organization: string;
  applicationId: string;
  test: { id: string; agent: SimulatedAgent };
  production: { id: string; agent: SimulatedAgent };
  build: (kind: 'feature' | 'rc' | 'final', status?: string) => Promise<string>;
}

const setUp = async (): Promise<Setup> => {
  const platformAdmin = await signIn('platform-admin');
  const adminName = unique('admin');
  const { body: created } = await platformAdmin
    .post('/api/v1/platform/companies')
    .send({ name: unique('Company'), firstAdminEmail: `${adminName}@example.com` })
    .expect(201);
  const admin = await signIn(adminName);
  await admin.post('/api/v1/invitations/accept').send({ token: created.invitation.token }).expect(200);
  const member = async (role: string) => {
    const name = unique(role);
    const { body } = await admin.post('/api/v1/company/invitations').send({ email: `${name}@example.com`, role }).expect(201);
    const agent = await signIn(name);
    await agent.post('/api/v1/invitations/accept').send({ token: body.token }).expect(200);
    return agent;
  };
  const [techLead, otherTechLead, developer, operator] = [
    await member('tech-lead'),
    await member('tech-lead'),
    await member('developer'),
    await member('operator'),
  ];
  const { body: application } = await techLead.post('/api/v1/company/applications').send({ name: 'Billing API', type: 'restful-service' }).expect(201);
  const environment = async (kind: 'test' | 'production', name: string) => {
    const { body } = await operator.post('/api/v1/company/environments').send({ name, kind }).expect(201);
    const { body: connection } = await operator.post(`/api/v1/company/environments/${body.id}/target`).expect(201);
    return { id: body.id as string, agent: await new SimulatedAgent().connect(connection.registrationToken) };
  };
  const test = await environment('test', 'Staging');
  const production = await environment('production', 'Live');
  const build = async (kind: 'feature' | 'rc' | 'final', status = 'succeeded') => {
    const id = randomUUID();
    const tag = `${kind}-${id.slice(0, 8)}`;
    await superuser.query(
      `INSERT INTO builds.builds (id, company_id, application_id, kind, branch, commit_sha, image_tag, version, status, image_ref, digest, signing_key)
       VALUES ($1, $2, $3, $4, 'feature/x', $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        created.company.id,
        application.id,
        kind,
        'a'.repeat(40),
        tag,
        kind === 'final' ? `1.${counter}.0` : null,
        status,
        `registry.test/${created.company.slug}/billing-api:${tag}`,
        `sha256:${randomBytes(32).toString('hex')}`,
        kind === 'final' ? 'release' : 'test',
      ],
    );
    return id;
  };
  return {
    admin,
    techLead,
    otherTechLead,
    developer,
    operator,
    companyId: created.company.id,
    organization: created.company.slug,
    applicationId: application.id,
    test,
    production,
    build,
  };
};

const deployment = async (agent: Agent, id: string) => (await agent.get(`/api/v1/company/deployments/${id}`).expect(200)).body;

/** The environment repository's files for one environment. */
const repositoryFiles = (setup: Setup, environment: 'staging' | 'live') =>
  repositories.files(setup.organization, `environment-${environment}`);

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
  repositories = app.get(ENVIRONMENT_REPOSITORIES);
  secrets = app.get(SECRET_STORE);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await superuser?.end();
  await database?.stop();
});

describe('a connected agent', () => {
  it('registers its deploy key and gets the configuration of its environment only', async () => {
    const setup = await setUp();
    const deployKey = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(43)}`;

    await setup.production.agent.call('put', '/deploy-key').send({ publicKey: `${deployKey} comment` }).expect(204);
    await setup.production.agent.call('put', '/deploy-key').send({ publicKey: 'ssh-rsa AAAA' }).expect(400);
    const { body } = await setup.production.agent.call('get', '/configuration').expect(200);

    expect(repositories.deployKeys.get(`${setup.organization}/environment-live`)).toEqual([
      { title: `target-${setup.production.agent.targetId}`, key: deployKey },
    ]);
    expect(body.environment).toMatchObject({ name: 'Live', kind: 'production', acceptedImages: ['final'] });
    expect(body.git).toEqual({
      url: `ssh://git@git.target.test:2222/${setup.organization}/environment-live.git`,
      branch: 'main',
      knownHosts: expect.stringContaining('ssh-ed25519'),
    });
    expect(body.registry).toMatchObject({ host: 'registry.target.test', organization: setup.organization, username: `${setup.organization}-pull` });
    expect(body.secrets).toMatchObject({ url: 'http://openbao.target.test', path: `${setup.companyId}/${setup.production.id}` });
    // Production trusts the release key only.
    const { body: keys } = await setup.admin.get('/api/v1/company/signing-keys').expect(200);
    expect(body.trustedKey).toBe(keys.find((key: { purpose: string }) => key.purpose === 'release').publicKey);
    expect(secrets.tokens.at(-1)).toEqual({ policyName: `target-${setup.production.id}`, path: `${setup.companyId}/${setup.production.id}` });

    await setup.operator.delete(`/api/v1/company/environments/${setup.production.id}/target`).expect(204);
    await eventually(() => expect(repositories.deployKeys.get(`${setup.organization}/environment-live`)).toEqual([]));
  });
});

describe('variables and secrets', () => {
  it('are managed by Tech Leads and Operators, and by Company Admins in test environments only', async () => {
    const setup = await setUp();

    await setup.admin.put(`/api/v1/company/environments/${setup.test.id}/variables/LOG_LEVEL`).send({ value: 'debug' }).expect(204);
    const { body: refused } = await setup.admin
      .put(`/api/v1/company/environments/${setup.production.id}/variables/LOG_LEVEL`)
      .send({ value: 'info' })
      .expect(403);
    expect(refused.detail).toBe("Only Tech Leads and Operators manage production's variables and secrets.");
    await setup.techLead.put(`/api/v1/company/environments/${setup.production.id}/variables/LOG_LEVEL`).send({ value: 'info' }).expect(204);
    await setup.developer.put(`/api/v1/company/environments/${setup.test.id}/variables/LOG_LEVEL`).send({ value: 'x' }).expect(403);
    await setup.operator.put(`/api/v1/company/environments/${setup.test.id}/variables/lowercase`).send({ value: 'x' }).expect(400);
    await setup.operator.put(`/api/v1/company/environments/${setup.test.id}/variables/PORT`).send({ value: '1' }).expect(400);
  });

  it('keep secret values in the secret store only, per environment and application', async () => {
    const setup = await setUp();
    const base = `/api/v1/company/environments/${setup.test.id}`;

    await setup.operator.put(`${base}/secrets/DATABASE_URL`).send({ value: 'postgres://shared' }).expect(204);
    await setup.operator.put(`${base}/secrets/API_KEY`).send({ value: 'fake-dummy-key', application: setup.applicationId }).expect(204);
    await setup.operator.put(`${base}/variables/API_KEY`).send({ value: 'x', application: setup.applicationId }).expect(409);

    expect(secrets.values.get(`${setup.companyId}/${setup.test.id}/shared`)).toEqual({ DATABASE_URL: 'postgres://shared' });
    expect(secrets.values.get(`${setup.companyId}/${setup.test.id}/apps/billing-api`)).toEqual({ API_KEY: 'fake-dummy-key' });
    const { rows } = await superuser.query('SELECT * FROM environments.secrets WHERE environment_id = $1', [setup.test.id]);
    expect(JSON.stringify(rows)).not.toContain('postgres://shared');

    const { body } = await setup.developer.get(`${base}/config?application=${setup.applicationId}`).expect(200);
    expect(body.secrets.map((secret: { name: string; scope: string }) => [secret.name, secret.scope])).toEqual([
      ['API_KEY', 'application'],
      ['DATABASE_URL', 'environment'],
    ]);
    expect(JSON.stringify(body)).not.toContain('fake-dummy-key');

    await setup.operator.delete(`${base}/secrets/DATABASE_URL`).expect(204);
    expect(secrets.values.get(`${setup.companyId}/${setup.test.id}/shared`)).toEqual({});
  });
});

describe('deployments', () => {
  it('commit the version to the environment repository, and finish as the agent reports', async () => {
    const setup = await setUp();
    await setup.operator.put(`/api/v1/company/environments/${setup.test.id}/variables/GREETING`).send({ value: 'hello' }).expect(204);
    await setup.operator
      .put(`/api/v1/company/environments/${setup.test.id}/secrets/API_KEY`)
      .send({ value: 'fake-dummy-key', application: setup.applicationId })
      .expect(204);
    const version = await setup.build('feature');

    const { body: requested } = await setup.developer
      .post(`/api/v1/company/applications/${setup.applicationId}/deployments`)
      .send({ environment: setup.test.id, version, strategy: 'rolling' })
      .expect(201);
    expect(requested).toMatchObject({ status: 'queued', strategy: 'rolling', environment: { name: 'Staging' } });

    await eventually(async () => expect((await deployment(setup.developer, requested.id)).status).toBe('committed'));
    const files = repositoryFiles(setup, 'staging');
    expect(parse(files.get('kustomization.yaml')!).resources).toEqual(['apps/billing-api']);
    const rollout = parse(files.get('apps/billing-api/workload.yaml')!);
    expect(rollout.metadata.annotations['dreamdevops.io/deployment']).toBe(requested.id);
    expect(rollout.spec.template.spec.containers[0].image).toMatch(new RegExp(`^registry\\.target\\.test/${setup.organization}/billing-api@sha256:`));
    expect(parse(files.get('apps/billing-api/config.yaml')!).data).toMatchObject({ GREETING: 'hello' });
    expect(parse(files.get('apps/billing-api/secrets.yaml')!).spec.dataFrom).toEqual([
      { extract: { key: `${setup.companyId}/${setup.test.id}/apps/billing-api` } },
    ]);

    await setup.test.agent.heartbeat([workload(requested.id, 'Progressing', 1)]);
    expect(await deployment(setup.developer, requested.id)).toMatchObject({ status: 'progressing', progress: { applied: true, ready: 1, desired: 2 } });
    await setup.test.agent.heartbeat([workload(requested.id, 'Healthy')]);
    expect(await deployment(setup.developer, requested.id)).toMatchObject({ status: 'succeeded', finishedAt: expect.any(String) });
  });

  it('keep production for final versions, and wait for a second person when it needs approval', async () => {
    const setup = await setUp();
    const deploy = (agent: Agent, version: string) =>
      agent.post(`/api/v1/company/applications/${setup.applicationId}/deployments`).send({ environment: setup.production.id, version, strategy: 'rolling' });

    expect((await deploy(setup.techLead, await setup.build('rc')).expect(409)).body.detail).toBe('Production takes final versions only.');
    await deploy(setup.developer, await setup.build('final')).expect(403);
    await setup.admin.patch(`/api/v1/company/environments/${setup.production.id}`).send({ requiresApproval: true }).expect(204);
    await setup.admin.patch(`/api/v1/company/environments/${setup.test.id}`).send({ requiresApproval: true }).expect(400);

    const { body } = await deploy(setup.techLead, await setup.build('final')).expect(201);
    expect(body.status).toBe('awaiting-approval');
    expect((await setup.techLead.post(`/api/v1/company/deployments/${body.id}/approve`).expect(403)).body.detail).toBe(
      'Someone else must approve your deployment.',
    );
    await setup.developer.post(`/api/v1/company/deployments/${body.id}/approve`).expect(403);
    await setup.otherTechLead.post(`/api/v1/company/deployments/${body.id}/approve`).expect(204);
    await eventually(async () => expect((await deployment(setup.techLead, body.id)).status).toBe('committed'));
    expect((await deployment(setup.techLead, body.id)).approvedBy).toMatchObject({ displayName: expect.any(String) });
  });

  it('allow one deployment of an application to an environment at a time, and only to a connected target', async () => {
    const setup = await setUp();
    const deploy = () =>
      setup.developer
        .post(`/api/v1/company/applications/${setup.applicationId}/deployments`)
        .send({ environment: setup.test.id, version: '', strategy: 'rolling' });
    const version = await setup.build('feature');
    const request = (strategy = 'rolling') =>
      setup.developer
        .post(`/api/v1/company/applications/${setup.applicationId}/deployments`)
        .send({ environment: setup.test.id, version, strategy });

    await deploy().expect(400);
    expect((await request('canary').expect(403)).body.detail).toBe('Canary and A/B deployments need the Commercial Edition.');
    await request().expect(201);
    expect((await request().expect(409)).body.detail).toBe('A deployment of this application to Staging is still going.');

    await setup.operator.delete(`/api/v1/company/environments/${setup.production.id}/target`).expect(204);
    const { body } = await setup.techLead
      .post(`/api/v1/company/applications/${setup.applicationId}/deployments`)
      .send({ environment: setup.production.id, version: await setup.build('final'), strategy: 'rolling' })
      .expect(409);
    expect(body.detail).toBe('Live has no connected target yet.');
  });

  it('wait on the preview for blue/green, promote through the agent, abort back, and roll back', async () => {
    const setup = await setUp();
    const deploy = async (version: string, strategy = 'blue-green') =>
      (
        await setup.developer
          .post(`/api/v1/company/applications/${setup.applicationId}/deployments`)
          .send({ environment: setup.test.id, version, strategy })
          .expect(201)
      ).body as { id: string };
    const commit = async (id: string) => eventually(async () => expect((await deployment(setup.developer, id)).status).toBe('committed'));

    const first = await deploy(await setup.build('feature'));
    await commit(first.id);
    await setup.test.agent.heartbeat([workload(first.id, 'Healthy')]);

    const second = await deploy(await setup.build('feature'));
    await commit(second.id);
    await setup.test.agent.heartbeat([workload(second.id, 'Paused')]);
    expect(await deployment(setup.developer, second.id)).toMatchObject({ status: 'paused' });
    await setup.developer.post(`/api/v1/company/deployments/${second.id}/promote`).expect(204);
    const [promote] = await setup.test.agent.heartbeat([workload(second.id, 'Paused')]);
    expect(promote).toMatchObject({ action: 'promote', namespace: 'billing-api', name: 'billing-api' });
    expect(await setup.test.agent.heartbeat([workload(second.id, 'Paused')])).toEqual([]);
    await setup.test.agent.call('post', `/commands/${promote!.id}`).send({ succeeded: true }).expect(204);
    await setup.test.agent.heartbeat([workload(second.id, 'Healthy')]);
    expect((await deployment(setup.developer, second.id)).status).toBe('succeeded');
    // Only the newest version that ran well is running there.
    expect((await deployment(setup.developer, first.id)).status).toBe('superseded');

    // A third version is aborted: Git goes back to the second.
    const third = await deploy(await setup.build('feature'));
    await commit(third.id);
    await setup.test.agent.heartbeat([workload(third.id, 'Paused')]);
    await setup.developer.post(`/api/v1/company/deployments/${third.id}/abort`).expect(204);
    const [abort] = await setup.test.agent.heartbeat([workload(third.id, 'Paused')]);
    expect(abort?.action).toBe('abort');
    await setup.test.agent.heartbeat([workload(third.id, 'Aborted', 0)]);
    expect((await deployment(setup.developer, third.id)).status).toBe('aborted');
    await eventually(() => {
      const restored = parse(repositoryFiles(setup, 'staging').get('apps/billing-api/workload.yaml')!);
      expect(restored.metadata.annotations['dreamdevops.io/deployment']).toBe(second.id);
    });

    // Rolling back the second runs the first again, and switches traffic by itself.
    const { body: rollback } = await setup.developer.post(`/api/v1/company/deployments/${second.id}/rollback`).expect(201);
    expect(rollback).toMatchObject({ rollbackOf: second.id, strategy: 'blue-green', version: { buildId: (await deployment(setup.developer, first.id)).version.buildId } });
    await commit(rollback.id);
    // The same heartbeat that reports the pause gets the promote back.
    const [automatic] = await setup.test.agent.heartbeat([workload(rollback.id, 'Paused')]);
    expect(automatic?.action).toBe('promote');
    expect(await setup.test.agent.heartbeat([workload(rollback.id, 'Paused')])).toEqual([]);
  });

  it('fail a rollout that degrades, and put the last good version back', async () => {
    const setup = await setUp();
    const deploy = async (version: string) =>
      (
        await setup.developer
          .post(`/api/v1/company/applications/${setup.applicationId}/deployments`)
          .send({ environment: setup.test.id, version, strategy: 'recreate' })
          .expect(201)
      ).body as { id: string };
    const good = await deploy(await setup.build('feature'));
    await eventually(async () => expect((await deployment(setup.developer, good.id)).status).toBe('committed'));
    await setup.test.agent.heartbeat([workload(good.id, 'Healthy')]);

    const bad = await deploy(await setup.build('feature'));
    await eventually(async () => expect((await deployment(setup.developer, bad.id)).status).toBe('committed'));
    await setup.test.agent.heartbeat([workload(bad.id, 'Degraded', 0)]);

    expect(await deployment(setup.developer, bad.id)).toMatchObject({ status: 'failed', message: 'ProgressDeadlineExceeded' });
    await eventually(() => {
      const restored = parse(repositoryFiles(setup, 'staging').get('apps/billing-api/workload.yaml')!);
      expect(restored.metadata.annotations['dreamdevops.io/deployment']).toBe(good.id);
    });
  });
});
