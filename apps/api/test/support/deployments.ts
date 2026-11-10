// Builds a world for deployment tests: companies with applications, images that built,
// and fake hosts to deploy them to. Each test file that imports it gets its own.
import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { expect } from 'vitest';
import { BUILD_SOURCE, IMAGE_BUILDER, IMAGE_REGISTRY, IMAGE_SCANNER } from '../../src/builds/application/ports.ts';
import { IMAGE_SIGNING_KEY } from '../../src/builds/application/tokens.ts';
import { SigningKey } from '../../src/builds/domain/signature.ts';
import { webhookSecret } from '../../src/builds/domain/webhook-signature.ts';
import { HOST_RUNTIMES } from '../../src/environments/application/ports.ts';
import { IDENTITY_PROVIDER } from '../../src/identity-access/application/ports.ts';
import { SOURCE_HOST } from '../../src/source-governance/application/ports.ts';
import { GIT_PROVIDER } from '../../src/tenancy/application/ports.ts';
import {
  FakeBuildSource,
  FakeGitProvider,
  FakeHostRuntime,
  FakeIdentityProvider,
  FakeImageBuilder,
  FakeImageRegistry,
  FakeImageScanner,
  FakeSourceHost,
} from '../fakes.ts';
import { type Agent, eventually as waitUntil, signIn as signInAs, unique } from './integration.ts';

export type { Agent } from './integration.ts';
import { buildApp } from '../test-app.ts';
import { startTestDatabase, type TestDatabase } from '../test-database.ts';

const WEBHOOK_SECRET = 'fake-dummy-webhook-secret';

let database: TestDatabase;
let ownerPool: pg.Pool;
let app: INestApplication;
export const git = new FakeBuildSource();
export const registry = new FakeImageRegistry();
const builder = new FakeImageBuilder(registry);
/** This machine, and a second kind of host that deploys too, to test moving between them. */
export const local = new FakeHostRuntime('local');
export const dockerHost = new FakeHostRuntime('docker');

/** The running app, and the database as its owner sees it. Available once started. */
export const harness = {
  get app(): INestApplication {
    return app;
  },
  get database(): TestDatabase {
    return database;
  },
  get ownerPool(): pg.Pool {
    return ownerPool;
  },
};

export const eventually = (assertion: () => Promise<void> | void) => waitUntil(assertion, { timeout: 25_000 });
const signIn = (user: string) => signInAs(app, user);

export interface Step {
  key: string;
  name: string;
  status: string;
  summary: string | null;
  checks: { name: string; outcome: string; detail: string | null }[];
  facts: { label: string; value: string }[];
}

export interface Deployment {
  id: string;
  number: number;
  kind: string;
  status: string;
  version: string | null;
  imageKind: string | null;
  productive: boolean;
  image: string | null;
  production: boolean;
  target: { id: string; name: string; provider: { key: string } };
  previousTarget: { id: string; name: string } | null;
  address: string | null;
  attempts: number;
  lastError: string | null;
  requestedBy: { displayName: string | null } | null;
  reason: string | null;
  steps: Step[];
}

export interface Environment {
  id: string;
  name: string;
  version: number;
  production: boolean;
  target: { id: string; name: string } | null;
  live: {
    deploymentId: string;
    buildId: string | null;
    version: string;
    productive: boolean;
    address: string | null;
    target: { id: string; name: string };
  } | null;
  deploying: { id: string; status: string } | null;
  variables: number;
  settingsPending: boolean;
}

export interface Option {
  buildId: string;
  version: string;
  kind: string;
  productive: boolean;
  problem: string | null;
  live: boolean;
}

export interface Build {
  id: string;
  kind: string;
  version: string;
  status: string;
  image: string | null;
  digest: string | null;
  pullRequest: number | null;
}

export const addMember = async (admin: Agent, role: string) => {
  const name = unique(role);
  const { body } = await admin.post('/api/v1/company/invitations').send({ email: `${name}@example.com`, role }).expect(201);
  const agent = await signIn(name);
  await agent.post('/api/v1/invitations/accept').send({ token: body.token }).expect(200);
  return agent;
};

/** A company with an application whose repository is ready, and one person in each role. */
export const setUp = async () => {
  const platformAdmin = await signIn('platform-admin');
  const adminName = unique('admin');
  const { body } = await platformAdmin
    .post('/api/v1/platform/companies')
    .send({ name: unique('Company'), firstAdminEmail: `${adminName}@example.com` })
    .expect(201);
  const admin = await signIn(adminName);
  await admin.post('/api/v1/invitations/accept').send({ token: body.invitation.token }).expect(200);
  await eventually(async () => {
    const { rows } = await ownerPool.query('SELECT status FROM tenancy.companies WHERE id = $1', [body.company.id]);
    expect(rows[0].status).toBe('active');
  });
  const { body: application } = await admin
    .post('/api/v1/company/applications')
    .send({ name: unique('Billing'), type: 'restful-service' })
    .expect(201);
  await eventually(async () => {
    const { body: repositories } = await admin.get('/api/v1/company/repositories').expect(200);
    expect(repositories.find((repository: { applicationId: string }) => repository.applicationId === application.id)?.status).toBe(
      'ready',
    );
  });
  return {
    admin,
    techLead: await addMember(admin, 'tech-lead'),
    developer: await addMember(admin, 'developer'),
    operator: await addMember(admin, 'operator'),
    viewer: await addMember(admin, 'viewer'),
    companyId: body.company.id as string,
    organization: body.company.slug as string,
    applicationId: application.id as string,
    name: application.slug as string,
  };
};
export type World = Awaited<ReturnType<typeof setUp>>;

export const builds = async (world: World) =>
  (await world.techLead.get(`/api/v1/company/applications/${world.applicationId}/builds`).expect(200)).body as Build[];

export const builtImage = async (world: World, id: string) => {
  let result: Build | undefined;
  await eventually(async () => {
    result = (await builds(world)).find((build) => build.id === id);
    expect(result?.status).toBe('succeeded');
  });
  return result!;
};

let pullRequestNumber = 100;
/** A development image of a new feature pull request. */
export const developmentImage = async (world: World) => {
  pullRequestNumber += 1;
  git.openPullRequest(world.organization, world.name, { number: pullRequestNumber, branch: `feature/change-${pullRequestNumber}` });
  const { body } = await world.developer
    .post(`/api/v1/company/applications/${world.applicationId}/pull-requests/${pullRequestNumber}/builds`)
    .expect(202);
  return builtImage(world, (body as Build).id);
};

/** A release candidate, and then its release, merged into main. */
export const releaseImages = async (world: World) => {
  const { body: candidate } = await world.techLead
    .post(`/api/v1/company/applications/${world.applicationId}/releases`)
    .send({ bump: 'minor' })
    .expect(202);
  const built = await builtImage(world, (candidate as Build).id);
  pullRequestNumber += 1;
  const branch = `release/${built.version.replace(/-rc\.\d+$/, '')}`;
  git.openPullRequest(world.organization, world.name, { number: pullRequestNumber, branch, base: 'main' });
  const merged = git.merge(world.organization, world.name, pullRequestNumber);
  const body = JSON.stringify({
    action: 'closed',
    number: merged.number,
    pull_request: {
      number: merged.number,
      title: merged.title,
      state: 'closed',
      merged: true,
      merge_commit_sha: merged.mergeCommit,
      html_url: merged.url,
      head: { ref: merged.head.branch, sha: merged.head.commit, repo: { full_name: merged.head.repository } },
      base: { ref: merged.base.branch },
    },
    repository: { full_name: `${world.organization}/${world.name}`, name: world.name },
  });
  await request(app.getHttpServer())
    .post('/api/v1/hooks/forgejo')
    .set('Content-Type', 'application/json')
    .set('X-Forgejo-Event', 'pull_request')
    .set('X-Forgejo-Signature', createHmac('sha256', webhookSecret(WEBHOOK_SECRET, world.organization, world.name)).update(body).digest('hex'))
    .send(body)
    .expect(204);
  let release: Build | undefined;
  await eventually(async () => {
    release = (await builds(world)).find((build) => build.kind === 'release' && build.pullRequest === merged.number);
    expect(release).toBeDefined();
  });
  return { candidate: built, release: await builtImage(world, release!.id) };
};

export const createEnvironment = async (world: World, agent: Agent, input: object) =>
  (await agent.post(`/api/v1/company/applications/${world.applicationId}/environments`).send(input).expect(201))
    .body as Environment;

export const environment = async (world: World, id: string) =>
  ((await world.viewer.get(`/api/v1/company/applications/${world.applicationId}/environments`).expect(200)).body as Environment[]).find(
    (candidate) => candidate.id === id,
  )!;

export const deploy = (agent: Agent, environmentId: string, body: object) =>
  agent.post(`/api/v1/company/environments/${environmentId}/deployments`).send(body);

export const finished = async (agent: Agent, id: string) => {
  let result: Deployment | undefined;
  await eventually(async () => {
    result = (await agent.get(`/api/v1/company/deployments/${id}`).expect(200)).body as Deployment;
    expect(['succeeded', 'failed']).toContain(result.status);
  });
  return result!;
};

/** Deploys an image and waits until it's done. */
export const deployed = async (agent: Agent, environmentId: string, body: object) =>
  finished(agent, ((await deploy(agent, environmentId, body).expect(202)).body as Deployment).id);

export const stepOf = (deployment: Deployment, key: string) => deployment.steps.find((step) => step.key === key)!;

export const digestOf = (build: Build) => `${build.image!.slice(0, build.image!.lastIndexOf(':'))}@${build.digest}`;

export const auditTypes = async (admin: Agent) =>
  ((await admin.get('/api/v1/company/audit').expect(200)).body.entries as { eventType: string }[]).map((entry) => entry.eventType);

/** Starts a database and the app, with fake Git, registry and hosts. Call it in beforeAll. */
export async function startDeploymentWorld(): Promise<void> {
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
      buildMaxAttempts: 2,
      buildRetrySeconds: 1,
      deployMaxAttempts: 2,
      deployRetrySeconds: 1,
      forgejoWebhookSecret: WEBHOOK_SECRET,
    },
    overrides: [
      { provide: IDENTITY_PROVIDER, useValue: new FakeIdentityProvider() },
      { provide: GIT_PROVIDER, useValue: new FakeGitProvider() },
      { provide: SOURCE_HOST, useValue: new FakeSourceHost() },
      { provide: BUILD_SOURCE, useValue: git },
      { provide: IMAGE_REGISTRY, useValue: registry },
      { provide: IMAGE_BUILDER, useValue: builder },
      { provide: IMAGE_SCANNER, useValue: new FakeImageScanner() },
      { provide: IMAGE_SIGNING_KEY, useValue: SigningKey.generate().key },
      { provide: HOST_RUNTIMES, useValue: [local, dockerHost] },
    ],
  });
}

export async function stopDeploymentWorld(): Promise<void> {
  await app?.close();
  await ownerPool?.end();
  await database?.stop();
}

/** Puts the fake hosts back to working normally. Call it in beforeEach. */
export function resetHosts(): void {
  for (const runtime of [local, dockerHost]) {
    runtime.enabled = true;
    runtime.failures.length = 0;
    runtime.unhealthy.clear();
  }
}
