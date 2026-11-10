import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILD_SOURCE,
  IMAGE_BUILDER,
  IMAGE_REGISTRY,
  IMAGE_SCANNER,
  PermanentBuildError,
} from '../src/builds/application/ports.ts';
import { IMAGE_SIGNING_KEY } from '../src/builds/application/tokens.ts';
import { readPayload, SigningKey, verifySignature } from '../src/builds/domain/signature.ts';
import { webhookSecret } from '../src/builds/domain/webhook-signature.ts';
import { IDENTITY_PROVIDER } from '../src/identity-access/application/ports.ts';
import { SOURCE_HOST } from '../src/source-governance/application/ports.ts';
import { GIT_PROVIDER } from '../src/tenancy/application/ports.ts';
import {
  FakeBuildSource,
  FakeGitProvider,
  FakeIdentityProvider,
  FakeImageBuilder,
  FakeImageRegistry,
  FakeImageScanner,
  FakeSourceHost,
  GOOD_DOCKERFILE,
} from './fakes.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';
import { type Agent, eventually as waitUntil, signIn as signInAs, unique } from './support/integration.ts';

const WEBHOOK_SECRET = 'fake-dummy-webhook-secret';

let database: TestDatabase;
let ownerPool: pg.Pool;
let app: INestApplication;
const host = new FakeSourceHost();
const git = new FakeBuildSource();
const registry = new FakeImageRegistry();
const builder = new FakeImageBuilder(registry);
const scanner = new FakeImageScanner();
const key = SigningKey.generate().key;

const eventually = (assertion: () => Promise<void> | void) => waitUntil(assertion, { timeout: 25_000 });

const signIn = (user: string) => signInAs(app, user);


interface BuildBody {
  id: string;
  number: number;
  kind: string;
  version: string;
  status: string;
  branch: string;
  commit: string;
  pullRequest: number | null;
  image: string | null;
  digest: string | null;
  attempts: number;
  lastError: string | null;
  requestedBy: { displayName: string | null } | null;
  steps: {
    key: string;
    name: string;
    status: string;
    summary: string | null;
    checks: { name: string; outcome: string; detail: string | null }[];
    facts: { label: string; value: string }[];
  }[];
}

const addMember = async (admin: Agent, role: string) => {
  const name = unique(role);
  const { body } = await admin.post('/api/v1/company/invitations').send({ email: `${name}@example.com`, role }).expect(201);
  const agent = await signIn(name);
  await agent.post('/api/v1/invitations/accept').send({ token: body.token }).expect(200);
  return agent;
};

/** A company with an application whose repository is ready, and a Tech Lead and Developer. */
const setUp = async () => {
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
  const organization = body.company.slug as string;
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
  const techLead = await addMember(admin, 'tech-lead');
  const developer = await addMember(admin, 'developer');
  const viewer = await addMember(admin, 'viewer');
  return {
    admin,
    techLead,
    developer,
    viewer,
    organization,
    name: application.slug as string,
    applicationId: application.id as string,
    companyId: body.company.id as string,
  };
};
type World = Awaited<ReturnType<typeof setUp>>;

const builds = async (agent: Agent, applicationId: string) =>
  (await agent.get(`/api/v1/company/applications/${applicationId}/builds`).expect(200)).body as BuildBody[];

const build = async (agent: Agent, id: string) => (await agent.get(`/api/v1/company/builds/${id}`).expect(200)).body as BuildBody;

const finished = async (agent: Agent, id: string) => {
  let result: BuildBody | undefined;
  await eventually(async () => {
    result = await build(agent, id);
    expect(['succeeded', 'failed']).toContain(result.status);
  });
  return result!;
};

const stepOf = (body: BuildBody, key: string) => body.steps.find((step) => step.key === key)!;

const auditTypes = async (admin: Agent) =>
  ((await admin.get('/api/v1/company/audit').expect(200)).body.entries as { eventType: string }[]).map(
    (entry) => entry.eventType,
  );

/** Sends a webhook the way Forgejo does, signed with the repository's secret. */
const deliver = (world: World, event: string, payload: object, options: { secret?: string } = {}) => {
  const body = JSON.stringify({
    ...payload,
    repository: { full_name: `${world.organization}/${world.name}`, name: world.name },
  });
  const secret = options.secret ?? webhookSecret(WEBHOOK_SECRET, world.organization, world.name);
  return request(app.getHttpServer())
    .post('/api/v1/hooks/forgejo')
    .set('Content-Type', 'application/json')
    .set('X-Forgejo-Event', event)
    .set('X-Forgejo-Signature', createHmac('sha256', secret).update(body).digest('hex'))
    .send(body);
};

const mergedPayload = (pullRequest: ReturnType<FakeBuildSource['merge']>) => ({
  action: 'closed',
  number: pullRequest.number,
  pull_request: {
    number: pullRequest.number,
    title: pullRequest.title,
    state: 'closed',
    merged: true,
    merge_commit_sha: pullRequest.mergeCommit,
    html_url: pullRequest.url,
    head: { ref: pullRequest.head.branch, sha: pullRequest.head.commit, repo: { full_name: pullRequest.head.repository } },
    base: { ref: pullRequest.base.branch },
  },
});

/** Starts a release and waits for its first candidate. */
const release = async (world: World, bump = 'minor') => {
  const { body } = await world.techLead
    .post(`/api/v1/company/applications/${world.applicationId}/releases`)
    .send({ bump })
    .expect(202);
  return finished(world.techLead, (body as BuildBody).id);
};

/** Merges a release or hotfix branch into main, tells the platform, and waits for the release build. */
const mergeIntoMain = async (world: World, branch: string, number: number) => {
  git.openPullRequest(world.organization, world.name, { number, branch, base: 'main' });
  const merged = git.merge(world.organization, world.name, number);
  await deliver(world, 'pull_request', mergedPayload(merged)).expect(204);
  let releaseBuild: BuildBody | undefined;
  await eventually(async () => {
    releaseBuild = (await builds(world.techLead, world.applicationId)).find((candidate) => candidate.kind === 'release' && candidate.pullRequest === number);
    expect(releaseBuild).toBeDefined();
  });
  return { merged, build: await finished(world.techLead, releaseBuild!.id) };
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
      provisioningMaxAttempts: 3,
      provisioningRetrySeconds: 1,
      buildMaxAttempts: 2,
      buildRetrySeconds: 1,
      forgejoWebhookSecret: WEBHOOK_SECRET,
    },
    overrides: [
      { provide: IDENTITY_PROVIDER, useValue: new FakeIdentityProvider() },
      { provide: GIT_PROVIDER, useValue: new FakeGitProvider() },
      { provide: SOURCE_HOST, useValue: host },
      { provide: BUILD_SOURCE, useValue: git },
      { provide: IMAGE_REGISTRY, useValue: registry },
      { provide: IMAGE_BUILDER, useValue: builder },
      { provide: IMAGE_SCANNER, useValue: scanner },
      { provide: IMAGE_SIGNING_KEY, useValue: key },
    ],
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await ownerPool?.end();
  await database?.stop();
});

beforeEach(() => {
  builder.failures.length = 0;
  builder.onBuild = null;
  builder.details = { user: 'node', healthcheck: true, sizeBytes: 123_400_000, exposedPorts: ['8080/tcp'] };
  scanner.report = { counts: { critical: 0, high: 0, medium: 2, low: 5, unknown: 0 }, findings: [] };
  scanner.name = 'Fake scanner';
  git.failures.length = 0;
});

describe('development images', () => {
  it('are built, scanned, published, signed and verified from a feature branch pull request', async () => {
    const world = await setUp();
    const pullRequest = git.openPullRequest(world.organization, world.name, { number: 7, branch: 'feature/login' });

    const { body: queued } = await world.developer
      .post(`/api/v1/company/applications/${world.applicationId}/pull-requests/7/builds`)
      .expect(202);

    expect(queued).toMatchObject({ kind: 'development', version: '0.1.0-dev.pr7.1', status: 'queued', branch: 'feature/login' });
    expect(queued.steps.map((step: { key: string }) => step.key)).toEqual([
      'checkout',
      'validate',
      'build',
      'inspect',
      'scan',
      'publish',
      'sign',
      'verify',
    ]);
    const done = await finished(world.developer, queued.id);
    expect(done.status).toBe('succeeded');
    expect(done.steps.every((step) => step.status === 'passed')).toBe(true);
    expect(done.commit).toBe(pullRequest.head.commit);
    const image = `registry.test/${world.organization}/${world.name}:0.1.0-dev.pr7.1`;
    expect(done.image).toBe(image);
    expect(done.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(done.requestedBy?.displayName).toMatch(/^developer-/);

    // The validations people see, one by one.
    expect(stepOf(done, 'validate').checks.map((check) => [check.name, check.outcome])).toEqual([
      ['The version is valid', 'passed'],
      ['The pull request is open', 'passed'],
      ['It comes from a feature branch of this repository', 'passed'],
      ['It targets develop', 'passed'],
      ['The repository has a Dockerfile', 'passed'],
      ['Base images are pinned by digest', 'passed'],
      ['Downloaded files are checked', 'passed'],
      ['No secrets in build arguments or environment variables', 'passed'],
      ['The repository has a .dockerignore file', 'passed'],
    ]);
    // The image carries its version and source.
    const labels = builder.built.find((entry) => entry.labels['dev.dreamdevops.build.id'] === done.id)!.labels;
    expect(labels['org.opencontainers.image.version']).toBe('0.1.0-dev.pr7.1');
    expect(labels['org.opencontainers.image.revision']).toBe(pullRequest.head.commit);
    // The signature in the registry is real, and covers this exact image.
    const [stored] = await registry.signatures(`registry.test/${world.organization}/${world.name}`, done.digest!);
    expect(verifySignature(key.publicKey, stored!.payload, stored!.signature)).toBe(true);
    expect(readPayload(stored!.payload)).toEqual({
      repository: `registry.test/${world.organization}/${world.name}`,
      digest: done.digest,
    });
    expect(stepOf(done, 'sign').facts).toContainEqual({ label: 'Key fingerprint', value: key.fingerprint });
    expect(stepOf(done, 'verify').checks.every((check) => check.outcome === 'passed')).toBe(true);
    // Nothing is left behind on the machine.
    expect(builder.removed).toContain(`dreamdevops-build:${done.id}`);
    expect(git.disposed).toContain(`/fake/${world.organization}/${world.name}/${pullRequest.head.commit}`);
    await eventually(async () => expect(await auditTypes(world.admin)).toEqual(expect.arrayContaining(['BuildQueued', 'BuildSucceeded'])));
  });

  it('are listed with each open feature pull request, and numbered per pull request', async () => {
    const world = await setUp();
    git.openPullRequest(world.organization, world.name, { number: 3, branch: 'feature/search' });
    git.openPullRequest(world.organization, world.name, { number: 4, branch: 'bugfix/typo' });

    const first = (
      await world.techLead.post(`/api/v1/company/applications/${world.applicationId}/pull-requests/3/builds`).expect(202)
    ).body as BuildBody;
    await finished(world.techLead, first.id);
    git.push(world.organization, world.name, 'feature/search');
    git.openPullRequest(world.organization, world.name, { number: 3, branch: 'feature/search' });
    const second = (
      await world.techLead.post(`/api/v1/company/applications/${world.applicationId}/pull-requests/3/builds`).expect(202)
    ).body as BuildBody;

    expect(second.version).toBe('0.1.0-dev.pr3.2');
    const { body: pullRequests } = await world.viewer
      .get(`/api/v1/company/applications/${world.applicationId}/pull-requests`)
      .expect(200);
    expect(pullRequests).toEqual([
      expect.objectContaining({ number: 3, branch: 'feature/search', latestBuild: expect.objectContaining({ version: '0.1.0-dev.pr3.2' }) }),
    ]);
  });

  it('refuse pull requests that are not from a feature branch of this repository into develop', async () => {
    const world = await setUp();
    git.openPullRequest(world.organization, world.name, { number: 1, branch: 'bugfix/typo' });
    git.openPullRequest(world.organization, world.name, { number: 2, branch: 'feature/x', base: 'main' });
    git.openPullRequest(world.organization, world.name, { number: 3, branch: 'feature/y', fork: true });
    git.openPullRequest(world.organization, world.name, { number: 4, branch: 'feature/z' });
    git.merge(world.organization, world.name, 4);
    const ask = (number: number) =>
      world.developer.post(`/api/v1/company/applications/${world.applicationId}/pull-requests/${number}/builds`);

    expect((await ask(1).expect(400)).body.detail).toBe('Development images are built from feature branches, such as feature/login.');
    expect((await ask(2).expect(400)).body.detail).toBe('The pull request must target develop.');
    expect((await ask(3).expect(400)).body.detail).toBe("The pull request's branch must be in the application's own repository.");
    expect((await ask(4).expect(400)).body.detail).toBe('Pull request #4 is closed.');
    await ask(99).expect(404);
    await world.developer.post(`/api/v1/company/applications/${world.applicationId}/pull-requests/abc/builds`).expect(400);
  });

  it('are built once per commit', async () => {
    const world = await setUp();
    git.openPullRequest(world.organization, world.name, { number: 5, branch: 'feature/once' });
    const ask = () => world.developer.post(`/api/v1/company/applications/${world.applicationId}/pull-requests/5/builds`);

    const { body } = await ask().expect(202);
    await finished(world.developer, body.id);

    expect((await ask().expect(409)).body.detail).toBe('This commit already has a development image: 0.1.0-dev.pr5.1.');
  });

  it('can only be asked for by Developers and Tech Leads', async () => {
    const world = await setUp();
    git.openPullRequest(world.organization, world.name, { number: 1, branch: 'feature/guarded' });

    await world.viewer.post(`/api/v1/company/applications/${world.applicationId}/pull-requests/1/builds`).expect(403);
    await world.admin.post(`/api/v1/company/applications/${world.applicationId}/pull-requests/1/builds`).expect(403);
    await world.viewer.get(`/api/v1/company/applications/${world.applicationId}/builds`).expect(200);
  });
});

describe('progress', () => {
  it('is saved after every step, so people can follow a build while it runs', async () => {
    const world = await setUp();
    git.openPullRequest(world.organization, world.name, { number: 1, branch: 'feature/slow' });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let seen: BuildBody | undefined;
    builder.onBuild = async () => {
      builder.onBuild = null;
      await gate;
    };

    const { body } = await world.developer
      .post(`/api/v1/company/applications/${world.applicationId}/pull-requests/1/builds`)
      .expect(202);
    await eventually(async () => {
      seen = await build(world.viewer, body.id);
      expect(stepOf(seen, 'build').status).toBe('running');
    });
    resume();

    expect(seen!.status).toBe('running');
    expect(seen!.steps.map((step) => step.status)).toEqual([
      'passed',
      'passed',
      'running',
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(stepOf(seen!, 'checkout').summary).toMatch(/^Checked out [0-9a-f]{12} from feature\/slow\.$/);
    expect((await finished(world.viewer, body.id)).status).toBe('succeeded');
  });
});

describe('releases', () => {
  it('build a release candidate when the release branch is created from develop', async () => {
    const world = await setUp();
    const developHead = git.push(world.organization, world.name, 'develop');

    const candidate = await release(world);

    expect(candidate).toMatchObject({ kind: 'release-candidate', version: '0.1.0-rc.1', branch: 'release/0.1.0', status: 'succeeded' });
    expect(candidate.commit).toBe(developHead);
    expect(git.repository(world.organization, world.name).branches.get('release/0.1.0')).toBe(developHead);
    expect(candidate.steps.map((step) => step.key)).not.toContain('tag');
    const { body: versions } = await world.viewer.get(`/api/v1/company/applications/${world.applicationId}/versions`).expect(200);
    expect(versions).toEqual({
      onMain: null,
      published: null,
      next: { minor: '0.1.0', major: '1.0.0', hotfix: null },
      lines: [
        {
          kind: 'release',
          branch: 'release/0.1.0',
          version: '0.1.0',
          latestCandidate: { id: candidate.id, version: '0.1.0-rc.1', status: 'succeeded' },
        },
      ],
    });
    await eventually(async () => expect(await auditTypes(world.admin)).toContain('ReleaseStarted'));
  });

  it('allow one release at a time, and only Tech Leads start them', async () => {
    const world = await setUp();
    await release(world);

    const { body } = await world.techLead
      .post(`/api/v1/company/applications/${world.applicationId}/releases`)
      .send({ bump: 'major' })
      .expect(409);
    expect(body.detail).toBe('Release 0.1.0 is already in progress on release/0.1.0. Finish it first.');
    await world.developer.post(`/api/v1/company/applications/${world.applicationId}/releases`).send({ bump: 'minor' }).expect(403);
    await world.techLead.post(`/api/v1/company/applications/${world.applicationId}/releases`).send({ bump: 'patch' }).expect(400);
  });

  it('treat a release whose branch was deleted as abandoned, so another can start', async () => {
    const world = await setUp();
    await release(world);
    git.repository(world.organization, world.name).branches.delete('release/0.1.0');

    const { body: versions } = await world.viewer.get(`/api/v1/company/applications/${world.applicationId}/versions`).expect(200);
    expect(versions.lines).toEqual([]);
    git.push(world.organization, world.name, 'develop');
    const restarted = await release(world);

    expect(restarted).toMatchObject({ version: '0.1.0-rc.2', branch: 'release/0.1.0', status: 'succeeded' });
  });

  it('build, sign and tag the release when its branch is merged into main', async () => {
    const world = await setUp();
    await release(world);

    const { merged, build: released } = await mergeIntoMain(world, 'release/0.1.0', 11);

    expect(released).toMatchObject({ kind: 'release', version: '0.1.0', status: 'succeeded', pullRequest: 11, requestedBy: null });
    expect(released.commit).toBe(merged.mergeCommit);
    expect(released.steps.map((step) => step.key)).toEqual([
      'checkout',
      'validate',
      'build',
      'inspect',
      'scan',
      'publish',
      'sign',
      'verify',
      'tag',
    ]);
    expect(stepOf(released, 'validate').checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'The version is newer than the latest release',
        'The pull request was merged into main',
        'The branch is named after the version',
        'The commit is the merge commit',
      ]),
    );
    expect(git.repository(world.organization, world.name).tags.get('v0.1.0')).toBe(merged.mergeCommit);
    expect(released.image).toBe(`registry.test/${world.organization}/${world.name}:0.1.0`);
    const { body: versions } = await world.viewer.get(`/api/v1/company/applications/${world.applicationId}/versions`).expect(200);
    expect(versions).toMatchObject({ onMain: '0.1.0', published: '0.1.0', lines: [], next: { minor: '0.2.0', hotfix: '0.1.1' } });
  });

  it('build one release however often the merge is reported', async () => {
    const world = await setUp();
    await release(world);
    const { merged } = await mergeIntoMain(world, 'release/0.1.0', 12);

    await deliver(world, 'pull_request', mergedPayload(merged)).expect(204);
    const { body } = await world.viewer.post(`/api/v1/company/applications/${world.applicationId}/builds/sync`).expect(201);

    expect(body).toEqual({ found: 0 });
    expect((await builds(world.viewer, world.applicationId)).filter((candidate) => candidate.kind === 'release')).toHaveLength(1);
  });

  it('find merges the webhook missed, such as while the API was stopped', async () => {
    const world = await setUp();
    await release(world);
    git.openPullRequest(world.organization, world.name, { number: 13, branch: 'release/0.1.0', base: 'main' });
    git.merge(world.organization, world.name, 13);

    const { body } = await world.viewer.post(`/api/v1/company/applications/${world.applicationId}/builds/sync`).expect(201);

    expect(body).toEqual({ found: 1 });
    const released = (await builds(world.viewer, world.applicationId)).find((candidate) => candidate.kind === 'release')!;
    expect((await finished(world.viewer, released.id)).status).toBe('succeeded');
  });

  it('build a new candidate after more changes reach the release branch', async () => {
    const world = await setUp();
    await release(world);
    const ask = () =>
      world.techLead.post(`/api/v1/company/applications/${world.applicationId}/candidates`).send({ branch: 'release/0.1.0' });

    expect((await ask().expect(409)).body.detail).toBe('0.1.0-rc.1 already covers the latest commit of release/0.1.0.');
    git.push(world.organization, world.name, 'release/0.1.0');
    const { body } = await ask().expect(202);

    expect(body.version).toBe('0.1.0-rc.2');
    expect((await finished(world.techLead, body.id)).status).toBe('succeeded');
    await world.techLead
      .post(`/api/v1/company/applications/${world.applicationId}/candidates`)
      .send({ branch: 'release/9.9.9' })
      .expect(409);
  });
});

describe('hotfixes', () => {
  it('need a release first', async () => {
    const world = await setUp();

    const { body } = await world.techLead.post(`/api/v1/company/applications/${world.applicationId}/hotfixes`).expect(409);

    expect(body.detail).toBe('Release a version before starting a hotfix.');
  });

  it('build a hotfix candidate from main, then release the patch version when merged', async () => {
    const world = await setUp();
    await release(world);
    const { merged } = await mergeIntoMain(world, 'release/0.1.0', 21);

    const { body } = await world.techLead.post(`/api/v1/company/applications/${world.applicationId}/hotfixes`).expect(202);
    const candidate = await finished(world.techLead, body.id);

    expect(candidate).toMatchObject({ kind: 'hotfix-candidate', version: '0.1.1-hotfix.1', branch: 'hotfix/0.1.1', status: 'succeeded' });
    expect(candidate.commit).toBe(merged.mergeCommit);
    const { build: patched } = await mergeIntoMain(world, 'hotfix/0.1.1', 22);
    expect(patched).toMatchObject({ kind: 'release', version: '0.1.1', status: 'succeeded' });
    await eventually(async () => expect(await auditTypes(world.admin)).toContain('HotfixStarted'));
  });
});

describe('branches created in Forgejo', () => {
  it('build a candidate once, even when the platform created the branch itself', async () => {
    const world = await setUp();
    const candidate = await release(world);

    await deliver(world, 'create', { ref: 'release/0.1.0', ref_type: 'branch', sha: candidate.commit }).expect(204);
    const commit = git.push(world.organization, world.name, 'hotfix/0.0.1');
    await deliver(world, 'create', { ref: 'hotfix/0.0.1', ref_type: 'branch', sha: commit }).expect(204);
    await deliver(world, 'create', { ref: 'feature/ignored', ref_type: 'branch', sha: commit }).expect(204);

    const all = await builds(world.viewer, world.applicationId);
    expect(all.map((entry) => entry.version).sort()).toEqual(['0.0.1-hotfix.1', '0.1.0-rc.1']);
  });
});

describe('webhooks', () => {
  it('are created for each new repository, with its own secret', async () => {
    const world = await setUp();

    await eventually(() =>
      expect(git.repository(world.organization, world.name).hooks).toEqual([
        { url: 'http://api.test/api/v1/hooks/forgejo', secret: webhookSecret(WEBHOOK_SECRET, world.organization, world.name) },
      ]),
    );
  });

  it('are refused without a valid signature', async () => {
    const world = await setUp();
    const commit = git.push(world.organization, world.name, 'release/0.1.0');
    const payload = { ref: 'release/0.1.0', ref_type: 'branch', sha: commit };

    await deliver(world, 'create', payload, { secret: 'a-guess' }).expect(401);
    await deliver(world, 'create', payload, { secret: webhookSecret(WEBHOOK_SECRET, 'another', 'repository') }).expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/hooks/forgejo')
      .set('Content-Type', 'application/json')
      .set('X-Forgejo-Event', 'create')
      .send({ ...payload, repository: { full_name: `${world.organization}/${world.name}` } })
      .expect(401);

    expect(await builds(world.viewer, world.applicationId)).toEqual([]);
  });
});

describe('failed builds', () => {
  it('stop at a failed validation, say why, and can be tried again once fixed', async () => {
    const world = await setUp();
    const repository = git.repository(world.organization, world.name);
    repository.files = { Dockerfile: 'FROM node:24-alpine\nARG NPM_TOKEN\nUSER node\n' };
    git.openPullRequest(world.organization, world.name, { number: 1, branch: 'feature/unpinned' });

    const { body } = await world.developer
      .post(`/api/v1/company/applications/${world.applicationId}/pull-requests/1/builds`)
      .expect(202);
    const failed = await finished(world.developer, body.id);

    expect(failed.status).toBe('failed');
    expect(failed.attempts).toBe(1);
    const validate = stepOf(failed, 'validate');
    expect(validate.status).toBe('failed');
    expect(validate.summary).toBe('2 checks failed.');
    expect(validate.checks.filter((check) => check.outcome === 'failed').map((check) => check.detail)).toEqual([
      'Not pinned: node:24-alpine on line 1. Add @sha256:<digest> to each, so every build uses the same base.',
      'ARG NPM_TOKEN on line 2. Both stay in the image, so pass secrets with RUN --mount=type=secret instead.',
    ]);
    expect(validate.checks.find((check) => check.outcome === 'warning')?.name).toBe('The repository has a .dockerignore file');
    expect(failed.steps.slice(2).every((step) => step.status === 'pending')).toBe(true);
    expect(failed.image).toBeNull();
    await eventually(async () => expect(await auditTypes(world.admin)).toContain('BuildFailed'));

    await world.viewer.post(`/api/v1/company/builds/${body.id}/retry`).expect(403);
    repository.files = { Dockerfile: GOOD_DOCKERFILE, '.dockerignore': '' };
    await world.developer.post(`/api/v1/company/builds/${body.id}/retry`).expect(202);
    expect((await finished(world.developer, body.id)).status).toBe('succeeded');
    await world.developer.post(`/api/v1/company/builds/${body.id}/retry`).expect(409);
  });

  it('stop when the image runs as root or has no health check', async () => {
    const world = await setUp();
    builder.details = { user: '', healthcheck: false, sizeBytes: 10, exposedPorts: [] };
    git.openPullRequest(world.organization, world.name, { number: 1, branch: 'feature/root' });

    const { body } = await world.developer
      .post(`/api/v1/company/applications/${world.applicationId}/pull-requests/1/builds`)
      .expect(202);
    const failed = await finished(world.developer, body.id);

    expect(stepOf(failed, 'inspect').checks.map((check) => check.outcome)).toEqual(['failed', 'failed']);
    expect(stepOf(failed, 'publish').status).toBe('pending');
  });

  it('stop on critical vulnerabilities, and warn about high ones', async () => {
    const world = await setUp();
    scanner.report = {
      counts: { critical: 1, high: 1, medium: 0, low: 0, unknown: 0 },
      findings: [
        { id: 'CVE-2026-0001', severity: 'critical', packageName: 'openssl', installedVersion: '3.0.1', fixedVersion: '3.0.2', title: null },
        { id: 'CVE-2026-0002', severity: 'high', packageName: 'zlib', installedVersion: '1.2', fixedVersion: null, title: null },
      ],
    };
    git.openPullRequest(world.organization, world.name, { number: 1, branch: 'feature/vulnerable' });

    const { body } = await world.developer
      .post(`/api/v1/company/applications/${world.applicationId}/pull-requests/1/builds`)
      .expect(202);
    const failed = await finished(world.developer, body.id);

    const scan = stepOf(failed, 'scan');
    expect(scan.summary).toBe('Found 1 critical vulnerability.');
    expect(scan.checks).toEqual([
      {
        name: 'No critical vulnerabilities',
        outcome: 'failed',
        detail: '1 found: CVE-2026-0001 in openssl 3.0.1 (fixed in 3.0.2). Update the affected packages or base image.',
      },
      { name: 'No high vulnerabilities', outcome: 'warning', detail: '1 found: CVE-2026-0002 in zlib 1.2. Review them before releasing.' },
    ]);
    expect(registry.tags.has(`registry.test/${world.organization}/${world.name}:0.1.0-dev.pr1.1`)).toBe(false);
  });

  it('try again after a temporary problem, from the start', async () => {
    const world = await setUp();
    builder.failures.push(new Error('Cannot connect to the Docker daemon.'));
    git.openPullRequest(world.organization, world.name, { number: 1, branch: 'feature/flaky' });

    const { body } = await world.developer
      .post(`/api/v1/company/applications/${world.applicationId}/pull-requests/1/builds`)
      .expect(202);
    const done = await finished(world.developer, body.id);

    expect(done.status).toBe('succeeded');
    expect(done.attempts).toBe(2);
    expect(done.lastError).toBeNull();
  });

  it('give up after the last attempt, or at once when trying again cannot help', async () => {
    const world = await setUp();
    builder.failures.push(new PermanentBuildError('The image didn\'t build: npm ERR! missing script: build'));
    git.openPullRequest(world.organization, world.name, { number: 1, branch: 'feature/broken' });

    const { body } = await world.developer
      .post(`/api/v1/company/applications/${world.applicationId}/pull-requests/1/builds`)
      .expect(202);
    const failed = await finished(world.developer, body.id);

    expect(failed).toMatchObject({ status: 'failed', attempts: 1, lastError: "The image didn't build: npm ERR! missing script: build" });
    expect(stepOf(failed, 'build').summary).toBe("The image didn't build: npm ERR! missing script: build");
  });

  it('refuse a release whose version is not newer than main', async () => {
    const world = await setUp();
    await release(world, 'major');
    await mergeIntoMain(world, 'release/1.0.0', 31);
    const commit = git.push(world.organization, world.name, 'release/0.5.0');
    await deliver(world, 'create', { ref: 'release/0.5.0', ref_type: 'branch', sha: commit }).expect(204);
    git.openPullRequest(world.organization, world.name, { number: 32, branch: 'release/0.5.0', base: 'main' });
    const merged = git.merge(world.organization, world.name, 32);

    await deliver(world, 'pull_request', mergedPayload(merged)).expect(204);
    let stale: BuildBody | undefined;
    await eventually(async () => {
      stale = (await builds(world.viewer, world.applicationId)).find((candidate) => candidate.version === '0.5.0');
      expect(stale).toBeDefined();
    });
    const failed = await finished(world.viewer, stale!.id);

    expect(failed.status).toBe('failed');
    expect(stepOf(failed, 'validate').checks.find((check) => check.outcome === 'failed')?.detail).toBe(
      "0.5.0 isn't newer than 1.0.0, which is already on main.",
    );
    expect(git.repository(world.organization, world.name).tags.has('v0.5.0')).toBe(false);
  });
});

describe('edge cases', () => {
  it('say when the Git service is unavailable, instead of failing vaguely', async () => {
    const world = await setUp();
    git.failures.push(new Error('The Git service could not be reached.'));

    const { body } = await world.viewer
      .get(`/api/v1/company/applications/${world.applicationId}/pull-requests`)
      .expect(503);

    expect(body.detail).toBe('The Git service could not be reached.');
  });

  it('show scanning as skipped when it is turned off, and still publish and sign', async () => {
    const world = await setUp();
    scanner.name = null;
    git.openPullRequest(world.organization, world.name, { number: 1, branch: 'feature/unscanned' });

    const { body } = await world.developer
      .post(`/api/v1/company/applications/${world.applicationId}/pull-requests/1/builds`)
      .expect(202);
    const done = await finished(world.developer, body.id);

    expect(done.status).toBe('succeeded');
    expect(stepOf(done, 'scan')).toMatchObject({
      status: 'skipped',
      summary: 'Vulnerability scanning is turned off on this server.',
    });
  });

  it('stop when the repository has no Dockerfile', async () => {
    const world = await setUp();
    git.repository(world.organization, world.name).files = { '.dockerignore': '' };
    git.openPullRequest(world.organization, world.name, { number: 1, branch: 'feature/no-dockerfile' });

    const { body } = await world.developer
      .post(`/api/v1/company/applications/${world.applicationId}/pull-requests/1/builds`)
      .expect(202);
    const failed = await finished(world.developer, body.id);

    expect(stepOf(failed, 'validate').checks.find((check) => check.outcome === 'failed')).toEqual({
      name: 'The repository has a Dockerfile',
      outcome: 'failed',
      detail: 'Add a Dockerfile at the top of the repository.',
    });
  });

  it('refuse IDs and branches that are not valid', async () => {
    const world = await setUp();
    const candidates = `/api/v1/company/applications/${world.applicationId}/candidates`;

    await world.viewer.get('/api/v1/company/builds/not-an-id').expect(400);
    await world.viewer.get('/api/v1/company/builds/00000000-0000-4000-8000-000000000000').expect(404);
    expect((await world.techLead.post(candidates).send({ branch: 'feature/x' }).expect(400)).body.detail).toBe(
      'Choose a release or hotfix branch, such as release/1.4.0.',
    );
    await release(world);
    git.repository(world.organization, world.name).branches.delete('release/0.1.0');
    expect((await world.techLead.post(candidates).send({ branch: 'release/0.1.0' }).expect(409)).body.detail).toBe(
      'The branch release/0.1.0 no longer exists.',
    );
  });
});

describe('archived applications', () => {
  it('get no new builds', async () => {
    const world = await setUp();
    git.openPullRequest(world.organization, world.name, { number: 1, branch: 'feature/late' });
    await world.admin.post(`/api/v1/company/applications/${world.applicationId}/archive`).expect(204);

    await world.developer.post(`/api/v1/company/applications/${world.applicationId}/pull-requests/1/builds`).expect(409);
    await world.techLead.post(`/api/v1/company/applications/${world.applicationId}/releases`).send({ bump: 'minor' }).expect(409);
  });
});

describe('company separation', () => {
  it("keeps each company's builds apart", async () => {
    const first = await setUp();
    const second = await setUp();
    git.openPullRequest(first.organization, first.name, { number: 1, branch: 'feature/private' });
    const { body } = await first.developer
      .post(`/api/v1/company/applications/${first.applicationId}/pull-requests/1/builds`)
      .expect(202);

    await second.techLead.get(`/api/v1/company/builds/${body.id}`).expect(404);
    await second.techLead.post(`/api/v1/company/builds/${body.id}/retry`).expect(404);
    await second.techLead.get(`/api/v1/company/applications/${first.applicationId}/builds`).expect(404);
    await finished(first.developer, body.id);
  });

  it('publishes the public key, for checking signatures', async () => {
    const world = await setUp();

    const { body } = await world.viewer.get('/api/v1/company/image-signing-key').expect(200);

    expect(body).toEqual({ algorithm: 'ECDSA P-256 with SHA-256', fingerprint: key.fingerprint, publicKey: key.publicKeyPem });
  });
});
