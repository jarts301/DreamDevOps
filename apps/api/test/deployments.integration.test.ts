import { generateKeyPairSync, type KeyObject, randomBytes, randomUUID, sign } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { IMAGE_REGISTRY } from '../src/builds/application/ports.ts';
import { SigningKeys } from '../src/builds/application/signing-keys.ts';
import { signaturePayload, signPayload } from '../src/builds/domain/cosign.ts';
import { HOST_RUNTIME } from '../src/deployments/application/ports.ts';
import { ENVIRONMENT_REPOSITORIES, SECRET_STORE } from '../src/environments/application/ports.ts';
import { IDENTITY_PROVIDER } from '../src/identity-access/application/ports.ts';
import { GIT_PROVIDER } from '../src/tenancy/application/ports.ts';
import {
  FakeEnvironmentRepositories,
  FakeGitProvider,
  type FakeHostRuntime,
  FakeIdentityProvider,
  type FakeImageRegistry,
  FakeSecretStore,
} from './fakes.ts';
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

/** Signs a build's image with the company's test key, as a passing build does. */
const signBuild = async (setup: Setup, buildId: string) => {
  const { rows } = await superuser.query<{ digest: string }>('SELECT digest FROM builds.builds WHERE id = $1', [buildId]);
  const digest = rows[0]!.digest;
  const privateKey = await runWithCompany(parseCompanyId(setup.companyId), () =>
    app.get(TenantDatabase).transaction((tx) => app.get(SigningKeys).privateKey(tx, 'test')),
  );
  const repository = `${setup.organization}/billing-api`;
  const payload = signaturePayload(`registry.test/${repository}`, digest);
  await app.get<FakeImageRegistry>(IMAGE_REGISTRY).pushSignature(repository, digest, payload, signPayload(privateKey, payload));
};

const deployment = async (agent: Agent, id: string) => (await agent.get(`/api/v1/company/deployments/${id}`).expect(200)).body;
/** The newest audit log entry of a type, with what it records. */
const auditEvent = async (agent: Agent, eventType: string) =>
  ((await agent.get('/api/v1/company/audit').expect(200)).body.entries as { eventType: string; payload: object }[]).find(
    (entry) => entry.eventType === eventType,
  )?.payload;

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

    const disconnect = (body: object) => setup.operator.delete(`/api/v1/company/environments/${setup.production.id}/target`).send(body);
    expect((await disconnect({}).expect(400)).body.detail).toBe('This affects production. To confirm, type its name exactly: Live');
    expect((await disconnect({ confirmation: 'Live' }).expect(400)).body.detail).toBe(
      "Say why you're changing production, in 10 to 500 characters.",
    );
    await disconnect({ confirmation: 'live', reason: 'Moving to the new cluster' }).expect(400);
    await disconnect({ confirmation: 'Live', reason: 'Moving to the new cluster' }).expect(204);
    await eventually(() => expect(repositories.deployKeys.get(`${setup.organization}/environment-live`)).toEqual([]));
    await eventually(async () =>
      expect(await auditEvent(setup.admin, 'TargetRevoked')).toMatchObject({ reason: 'Moving to the new cluster' }),
    );
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
    const production = (agent: Agent, body: object) =>
      agent.put(`/api/v1/company/environments/${setup.production.id}/variables/LOG_LEVEL`).send({ value: 'info', ...body });
    await production(setup.techLead, {}).expect(400);
    await production(setup.techLead, { confirmation: 'Live', reason: 'Quieter logs in production' }).expect(204);
    await setup.techLead
      .delete(`/api/v1/company/environments/${setup.production.id}/variables/LOG_LEVEL`)
      .send({ confirmation: 'Live' })
      .expect(400);
    await setup.developer.put(`/api/v1/company/environments/${setup.test.id}/variables/LOG_LEVEL`).send({ value: 'x' }).expect(403);
    const variable = (name: string) => setup.operator.put(`/api/v1/company/environments/${setup.test.id}/variables/${name}`);
    await variable('1_STARTS_WITH_A_DIGIT').send({ value: 'x' }).expect(400);
    await variable('PORT').send({ value: '1' }).expect(400);
    await variable('DREAMDEVOPS_ANYTHING').send({ value: '1' }).expect(400);
    await variable('LOG_LEVEL').send({ value: 'two\nlines' }).expect(400);
    // Lower case is fine, but not a second name that differs only in case.
    await variable('log_format').send({ value: 'json' }).expect(204);
    const { body: sameName } = await variable('LOG_FORMAT').send({ value: 'text' }).expect(409);
    expect(sameName.detail).toBe("log_format is already set here. Names can't differ only in case.");
    const { body: secret } = await setup.operator
      .put(`/api/v1/company/environments/${setup.test.id}/secrets/LOG_FORMAT`)
      .send({ value: 'x' })
      .expect(409);
    expect(secret.detail).toBe("A variable is already named log_format here. A variable can't become a secret, nor the other way round.");
  });

  it('keep each scope within 100 values', async () => {
    const setup = await setUp();
    for (let index = 0; index < 100; index += 1) {
      await setup.operator.put(`/api/v1/company/environments/${setup.test.id}/variables/V${index}`).send({ value: 'x' }).expect(204);
    }
    const { body } = await setup.operator
      .put(`/api/v1/company/environments/${setup.test.id}/variables/ONE_TOO_MANY`)
      .send({ value: 'x' })
      .expect(409);
    expect(body.detail).toBe('Each environment, and each application in it, can have up to 100 variables and secrets.');
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
    // What it runs with is recorded as it's committed: the blueprint's settings.
    expect(await deployment(setup.developer, requested.id)).toMatchObject({
      action: 'deploy',
      reason: null,
      limits: { cpu: '250m', memory: '256Mi' },
    });
    const files = repositoryFiles(setup, 'staging');
    expect(parse(files.get('kustomization.yaml')!).resources).toEqual(['apps/billing-api']);
    const rollout = parse(files.get('apps/billing-api/workload.yaml')!);
    expect(rollout.metadata.annotations['dreamdevops.io/deployment']).toBe(requested.id);
    expect(rollout.spec.template.spec.containers[0].image).toMatch(new RegExp(`^registry\\.target\\.test/${setup.organization}/billing-api@sha256:`));
    expect(parse(files.get('apps/billing-api/config.yaml')!).data).toMatchObject({
      GREETING: 'hello',
      DREAMDEVOPS_PRODUCTION: 'false',
      // Metrics and traces go to the target's collector, tagged with the environment.
      OTEL_SERVICE_NAME: 'billing-api',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://collector.target.test:4318/v1/metrics',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector.target.test:4318/v1/traces',
      OTEL_RESOURCE_ATTRIBUTES: `dreamdevops.environment.id=${setup.test.id}`,
    });
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
    const deploy = (agent: Agent, version: string, confirmation: string | null = 'Live') =>
      agent
        .post(`/api/v1/company/applications/${setup.applicationId}/deployments`)
        .send({ environment: setup.production.id, version, strategy: 'rolling', confirmation });

    expect((await deploy(setup.techLead, await setup.build('final'), null).expect(400)).body.detail).toBe(
      'This affects production. To confirm, type its name exactly: Live',
    );
    expect((await deploy(setup.techLead, await setup.build('rc')).expect(409)).body.detail).toBe('Production takes final versions only.');
    await deploy(setup.developer, await setup.build('final')).expect(403);
    const approval = { requiresApproval: true, confirmation: 'Live', reason: 'Two people for every release' };
    expect((await setup.admin.patch(`/api/v1/company/environments/${setup.production.id}`).send(approval).expect(403)).body.detail).toBe(
      'Only Tech Leads and Operators manage production environments.',
    );
    await setup.operator.patch(`/api/v1/company/environments/${setup.production.id}`).send({ requiresApproval: true }).expect(400);
    await setup.operator.patch(`/api/v1/company/environments/${setup.production.id}`).send(approval).expect(204);
    await setup.admin.patch(`/api/v1/company/environments/${setup.test.id}`).send({ requiresApproval: true }).expect(400);

    const { body } = await deploy(setup.techLead, await setup.build('final')).expect(201);
    expect(body.status).toBe('awaiting-approval');
    expect((await setup.techLead.post(`/api/v1/company/deployments/${body.id}/approve`).send({ confirmation: 'Live' }).expect(403)).body.detail).toBe(
      'Someone else must approve your deployment.',
    );
    await setup.developer.post(`/api/v1/company/deployments/${body.id}/approve`).send({ confirmation: 'Live' }).expect(403);
    await setup.otherTechLead.post(`/api/v1/company/deployments/${body.id}/approve`).expect(400);
    await setup.otherTechLead.post(`/api/v1/company/deployments/${body.id}/approve`).send({ confirmation: 'Live' }).expect(204);
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

    await setup.operator
      .delete(`/api/v1/company/environments/${setup.production.id}/target`)
      .send({ confirmation: 'Live', reason: 'Moving to the new cluster' })
      .expect(204);
    const { body } = await setup.techLead
      .post(`/api/v1/company/applications/${setup.applicationId}/deployments`)
      .send({ environment: setup.production.id, version: await setup.build('final'), strategy: 'rolling', confirmation: 'Live' })
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

  it('apply changed values to what runs, and stop it', async () => {
    const setup = await setUp();
    const app = `/api/v1/company/applications/${setup.applicationId}`;
    const running = async () => (await setup.admin.get(`/api/v1/company/running?environment=${setup.test.id}`).expect(200)).body;
    await setup.developer.post(`${app}/stop`).send({ environment: setup.test.id }).expect(409);

    const { body: first } = await setup.developer
      .post(`${app}/deployments`)
      .send({ environment: setup.test.id, version: await setup.build('feature'), strategy: 'rolling' })
      .expect(201);
    await eventually(async () => expect((await deployment(setup.developer, first.id)).status).toBe('committed'));
    await setup.test.agent.heartbeat([workload(first.id, 'Healthy')]);
    expect(await running()).toEqual([
      expect.objectContaining({
        deploymentId: first.id,
        application: expect.objectContaining({ slug: 'billing-api' }),
        limits: { cpu: '250m', memory: '256Mi' },
        settingsChanged: false,
      }),
    ]);

    // A changed value reaches what runs only when it starts again.
    await setup.operator.put(`/api/v1/company/environments/${setup.test.id}/variables/GREETING`).send({ value: 'hi' }).expect(204);
    expect((await running())[0].settingsChanged).toBe(true);
    const { body: applied } = await setup.developer.post(`${app}/apply`).send({ environment: setup.test.id }).expect(201);
    expect(applied).toMatchObject({ action: 'apply', status: 'queued', version: { buildId: first.version.buildId } });
    await eventually(async () => expect((await deployment(setup.developer, applied.id)).status).toBe('committed'));
    expect(parse(repositoryFiles(setup, 'staging').get('apps/billing-api/config.yaml')!).data.GREETING).toBe('hi');
    await setup.test.agent.heartbeat([workload(applied.id, 'Healthy')]);
    expect(await running()).toEqual([expect.objectContaining({ deploymentId: applied.id, settingsChanged: false })]);

    // Stopping removes its folder and its place in the root list, and finishes once its workload is gone.
    await setup.admin.post(`${app}/stop`).send({ environment: setup.test.id }).expect(403);
    const { body: stopped } = await setup.developer.post(`${app}/stop`).send({ environment: setup.test.id }).expect(201);
    expect(stopped).toMatchObject({ action: 'stop', status: 'queued' });
    await eventually(async () => expect((await deployment(setup.developer, stopped.id)).status).toBe('committed'));
    const files = repositoryFiles(setup, 'staging');
    expect([...files.keys()].some((path) => path.startsWith('apps/billing-api/'))).toBe(false);
    expect(parse(files.get('kustomization.yaml')!).resources).toEqual([]);
    await setup.test.agent.heartbeat([workload(applied.id, 'Healthy')], { revision: 'a'.repeat(40), ready: true, message: null });
    expect((await deployment(setup.developer, stopped.id)).status).toBe('committed');
    await setup.test.agent.heartbeat([], { revision: 'b'.repeat(40), ready: true, message: null });
    expect(await deployment(setup.developer, stopped.id)).toMatchObject({ status: 'succeeded', message: 'It no longer runs here.' });
    expect(await running()).toEqual([]);
    await setup.developer.post(`/api/v1/company/deployments/${stopped.id}/rollback`).expect(409);
  });

  it('stop production only with its name and a reason', async () => {
    const setup = await setUp();
    const app = `/api/v1/company/applications/${setup.applicationId}`;
    const { body: live } = await setup.techLead
      .post(`${app}/deployments`)
      .send({ environment: setup.production.id, version: await setup.build('final'), strategy: 'rolling', confirmation: 'Live' })
      .expect(201);
    await eventually(async () => expect((await deployment(setup.techLead, live.id)).status).toBe('committed'));
    await setup.production.agent.heartbeat([workload(live.id, 'Healthy')]);

    await setup.techLead.post(`${app}/stop`).send({ environment: setup.production.id, confirmation: 'Live' }).expect(400);
    await setup.developer.post(`${app}/stop`).send({ environment: setup.production.id, confirmation: 'Live', reason: 'Retiring the old API' }).expect(403);
    const { body } = await setup.techLead
      .post(`${app}/stop`)
      .send({ environment: setup.production.id, confirmation: 'Live', reason: 'Retiring the old API' })
      .expect(201);
    expect(body).toMatchObject({ action: 'stop', reason: 'Retiring the old API' });
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

describe('This machine', () => {
  it('lists where environments can run, and connects This machine without an agent', async () => {
    const setup = await setUp();
    const { body: providers } = await setup.developer.get('/api/v1/company/environments/providers').expect(200);
    expect(providers.map((provider: { key: string; unavailableReason: string | null }) => [provider.key, provider.unavailableReason === null])).toEqual([
      ['local', true],
      ['kubernetes', true],
      ['docker', false],
      ['aws', false],
      ['azure', false],
      ['gcp', false],
    ]);
    const { body: environment } = await setup.operator.post('/api/v1/company/environments').send({ name: 'Trial', kind: 'test' }).expect(201);
    const target = `/api/v1/company/environments/${environment.id}/target`;
    expect((await setup.operator.post(target).send({ provider: 'aws' }).expect(409)).body.detail).toBe(
      "Amazon Web Services targets aren't available yet.",
    );
    await setup.operator.post(target).send({ provider: 'local', settings: { password: 'x' } }).expect(400);

    const { body: connection } = await setup.operator.post(target).send({ provider: 'local', settings: { publicHost: 'trial.local' } }).expect(201);
    expect(connection).toEqual({ targetId: expect.any(String), provider: 'local', registrationToken: null, expiresAt: null, command: null });
    expect((await setup.developer.get(`/api/v1/company/environments/${environment.id}`).expect(200)).body.target).toMatchObject({
      provider: 'local',
      settings: { publicHost: 'trial.local' },
      status: 'connected',
    });
  });

  it('runs a signed version as a container with the environment values, rolls back an unhealthy one, and stops it', async () => {
    const setup = await setUp();
    const runtime = app.get<FakeHostRuntime>(HOST_RUNTIME);
    const { body: environment } = await setup.operator.post('/api/v1/company/environments').send({ name: 'Trial', kind: 'test' }).expect(201);
    await setup.operator.post(`/api/v1/company/environments/${environment.id}/target`).send({ provider: 'local', settings: { publicHost: 'trial.local' } }).expect(201);
    await setup.operator.put(`/api/v1/company/environments/${environment.id}/variables/GREETING`).send({ value: 'hello' }).expect(204);
    await setup.operator.put(`/api/v1/company/environments/${environment.id}/secrets/API_KEY`).send({ value: 'fake-dummy-key' }).expect(204);
    // Signatures are checked against the application's repository, which is made in the background.
    await eventually(async () =>
      expect((await setup.developer.get('/api/v1/company/repositories').expect(200)).body).toContainEqual(
        expect.objectContaining({ applicationId: setup.applicationId, status: 'ready' }),
      ),
    );
    const app_ = `/api/v1/company/applications/${setup.applicationId}`;
    const deploy = (version: string, strategy = 'rolling') =>
      setup.developer.post(`${app_}/deployments`).send({ environment: environment.id, version, strategy });
    const first = await setup.build('feature');
    await signBuild(setup, first);

    expect((await deploy(first, 'blue-green').expect(400)).body.detail).toBe(
      'This machine runs one copy of each application: choose rolling or recreate.',
    );
    const { body: running } = await deploy(first).expect(201);
    await eventually(async () => expect((await deployment(setup.developer, running.id)).status).toBe('succeeded'));
    const ran = await deployment(setup.developer, running.id);
    expect(ran).toMatchObject({
      message: expect.stringMatching(/^It runs at http:\/\/trial\.local:\d+\.$/),
      limits: { cpu: '1', memory: '512Mi' },
      progress: { applied: true, address: expect.stringMatching(/^http:\/\/trial\.local:/) },
    });
    const container = runtime.find('billing-api', 'trial')!;
    expect(container.request.image).toMatch(new RegExp(`^registry\\.test/${setup.organization}/billing-api@sha256:[0-9a-f]{64}$`));
    expect(container.request.environment).toMatchObject({
      GREETING: 'hello',
      API_KEY: 'fake-dummy-key',
      PORT: '8080',
      DREAMDEVOPS_ENVIRONMENT: 'trial',
      DREAMDEVOPS_PRODUCTION: 'false',
    });

    // An unhealthy version is removed, and the one before runs again, on the same port.
    const second = await setup.build('feature');
    await signBuild(setup, second);
    runtime.health = { healthy: false, detail: 'Its health check failed.' };
    try {
      const { body: bad } = await deploy(second).expect(201);
      await eventually(async () =>
        expect(await deployment(setup.developer, bad.id)).toMatchObject({
          status: 'failed',
          message: 'Its health check failed. The version before runs again.',
        }),
      );
    } finally {
      runtime.health = { healthy: true, detail: 'Its health check passed.' };
    }
    expect(runtime.find('billing-api', 'trial')!.request.labels['dreamdevops.deployment']).toBe(running.id);

    // An image without a valid signature is never pulled.
    const unsigned = await setup.build('feature');
    const pulled = runtime.pulled.length;
    const { body: refused } = await deploy(unsigned).expect(201);
    await eventually(async () => expect((await deployment(setup.developer, refused.id)).status).toBe('failed'));
    expect((await deployment(setup.developer, refused.id)).message).toMatch(/^The registry has the signature: .* Nothing was pulled\.$/);
    expect(runtime.pulled).toHaveLength(pulled);

    const { body: stopped } = await setup.developer.post(`${app_}/stop`).send({ environment: environment.id }).expect(201);
    await eventually(async () => expect((await deployment(setup.developer, stopped.id)).status).toBe('succeeded'));
    expect(runtime.find('billing-api', 'trial')).toBeUndefined();
  });
});
