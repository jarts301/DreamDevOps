import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Builds } from '../src/builds/application/builds.ts';
import { IMAGE_REGISTRY, PIPELINE_HOST } from '../src/builds/application/ports.ts';
import { signaturePayload, verifyPayload } from '../src/builds/domain/cosign.ts';
import { IDENTITY_PROVIDER } from '../src/identity-access/application/ports.ts';
import { SOURCE_HOST } from '../src/source-governance/application/ports.ts';
import { GIT_PROVIDER } from '../src/tenancy/application/ports.ts';
import { webhookSecret } from '../src/webhooks/domain/signature.ts';
import { FakeGitProvider, FakeIdentityProvider, FakeImageRegistry, FakePipelineHost, FakeSourceHost } from './fakes.ts';
import { buildApp, testConfig } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';

let database: TestDatabase;
let ownerPool: pg.Pool;
let app: INestApplication;
const source = new FakeSourceHost();
const registry = new FakeImageRegistry();
const pipelines = new FakePipelineHost();
const SECRET_KEY = testConfig().webhookSecretKey;
const ZERO = '0'.repeat(40);

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

interface Setup {
  admin: Agent;
  developer: Agent;
  techLead: Agent;
  viewer: Agent;
  applicationId: string;
  organization: string;
  name: string;
}

/** A company with one application whose repository is ready, and a member in each role. */
const setUp = async (): Promise<Setup> => {
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
  const member = async (role: string) => {
    const name = unique(role);
    const invited = await admin.post('/api/v1/company/invitations').send({ email: `${name}@example.com`, role }).expect(201);
    const agent = await signIn(name);
    await agent.post('/api/v1/invitations/accept').send({ token: invited.body.token }).expect(200);
    return agent;
  };
  const application = await admin
    .post('/api/v1/company/applications')
    .send({ name: unique('Service'), type: 'restful-service' })
    .expect(201);
  await eventually(async () => {
    const repositories = await admin.get('/api/v1/company/repositories').expect(200);
    expect(repositories.body[0]?.status).toBe('ready');
  });
  return {
    admin,
    developer: await member('developer'),
    techLead: await member('tech-lead'),
    viewer: await member('viewer'),
    applicationId: application.body.id,
    organization: body.company.slug,
    name: application.body.slug,
  };
};

/** Sends a webhook the way Forgejo does, signed with the repository's secret. */
const webhook = (
  setup: Setup,
  event: string,
  payload: object,
  options: { secret?: string; delivery?: string; repository?: string } = {},
) => {
  const body = JSON.stringify({
    repository: { full_name: options.repository ?? `${setup.organization}/${setup.name}` },
    ...payload,
  });
  const secret = options.secret ?? webhookSecret(SECRET_KEY, setup.applicationId);
  return request(app.getHttpServer())
    .post('/api/v1/webhooks/forgejo')
    .set('Content-Type', 'application/json')
    .set('X-Forgejo-Event', event)
    .set('X-Forgejo-Delivery', options.delivery ?? randomUUID())
    .set('X-Forgejo-Signature', createHmac('sha256', secret).update(body).digest('hex'))
    .send(body);
};

const push = (setup: Setup, branch: string, after: string, before = ZERO) =>
  webhook(setup, 'push', { ref: `refs/heads/${branch}`, before, after, commits: [{}], pusher: { login: 'fake|someone' } });

const job = (buildId: string, token = pipelines.tokenOf(buildId)) => {
  const base = `/api/v1/pipeline/builds/${buildId}`;
  const auth = { Authorization: `Bearer ${token}` };
  const server = app.getHttpServer();
  return {
    source: () => request(server).get(`${base}/source`).set(auth),
    started: (name: string) => request(server).post(`${base}/jobs/${name}/started`).set(auth),
    report: (kind: string, body: string, query = '') =>
      request(server).post(`${base}/reports/${kind}${query}`).set(auth).set('Content-Type', 'application/octet-stream').send(body),
    /** Uploads the image as the pipeline does: base64 parts, then the hash of the whole. */
    uploadImage: async (bytes: Buffer, partSize = 7) => {
      const parts = Math.ceil(bytes.length / partSize);
      for (let part = 0; part < parts; part += 1) {
        await request(server)
          .post(`${base}/image/parts/${part}`)
          .set(auth)
          .set('Content-Type', 'text/plain')
          .send(bytes.subarray(part * partSize, (part + 1) * partSize).toString('base64'))
          .expect(204);
      }
      return request(server)
        .post(`${base}/image/complete?parts=${parts}&sha256=${createHash('sha256').update(bytes).digest('hex')}`)
        .set(auth);
    },
    image: () => request(server).get(`${base}/image`).set(auth).buffer(true).parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    }),
  };
};

/** Plays every pipeline job for a build, with the results asked for. */
const runPipeline = async (
  buildId: string,
  options: { testsPass?: boolean; secrets?: object[]; critical?: number } = {},
) => {
  await eventually(() => expect(pipelines.tokenOf(buildId)).toBeDefined());
  const steps = job(buildId);
  await steps.source().expect(200);
  await steps.report('tests', 'All tests passed.', `?passed=${options.testsPass ?? true}`).expect(204);
  if (options.testsPass === false) {
    // The build has failed, so the secrets job's report comes too late and is refused.
    await steps.report('secrets', '[]').expect(401);
    return;
  }
  await steps.report('secrets', JSON.stringify(options.secrets ?? [])).expect(204);
  if ((options.secrets ?? []).length > 0) {
    return;
  }
  const image = Buffer.from(`image of ${buildId}`);
  expect((await steps.uploadImage(image)).status).toBe(204);
  expect((await steps.image().expect(200)).body).toEqual(image);
  const vulnerabilities = [
    ...Array.from({ length: options.critical ?? 0 }, () => ({ Severity: 'CRITICAL' })),
    { Severity: 'LOW' },
  ];
  await steps.report('scan', JSON.stringify({ Results: [{ Vulnerabilities: vulnerabilities }] })).expect(204);
  if ((options.critical ?? 0) > 0) {
    return;
  }
  await steps.report('sbom', JSON.stringify({ bomFormat: 'CycloneDX', components: [{ name: 'fastify' }, { name: 'pino' }] })).expect(204);
};

const buildsOf = async (agent: Agent, applicationId: string) =>
  (await agent.get(`/api/v1/company/applications/${applicationId}/builds`).expect(200)).body as {
    id: string;
    kind: string;
    status: string;
    tag: string;
    failureReason: string | null;
    imageRef: string | null;
    digest: string | null;
    signedWith: string | null;
    releaseId: string | null;
    progress: { job: string; state: string }[];
  }[];

/** Waits for a build to be asked for, which happens in the background. */
const buildTagged = async (setup: Setup, tag: string) => {
  let found: Awaited<ReturnType<typeof buildsOf>>[number] | undefined;
  await eventually(async () => {
    found = (await buildsOf(setup.techLead, setup.applicationId)).find((build) => build.tag === tag);
    expect(found).toBeDefined();
  });
  return found!;
};

const auditTypes = async (agent: Agent) =>
  ((await agent.get('/api/v1/company/audit').expect(200)).body.entries as { eventType: string }[]).map(
    (entry) => entry.eventType,
  );

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
      { provide: GIT_PROVIDER, useValue: new FakeGitProvider() },
      { provide: SOURCE_HOST, useValue: source },
      { provide: IMAGE_REGISTRY, useValue: registry },
      { provide: PIPELINE_HOST, useValue: pipelines },
    ],
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await ownerPool?.end();
  await database?.stop();
});

beforeEach(() => {
  registry.failing = false;
});

describe('repositories', () => {
  it('send their events to the gateway, signed with their own secret, and give teams access', async () => {
    const setup = await setUp();

    const repository = source.repositories.get(`${setup.organization}/${setup.name}`)!;
    expect(repository.webhook).toEqual({
      url: 'http://api.tools.test/api/v1/webhooks/forgejo',
      secret: webhookSecret(SECRET_KEY, setup.applicationId),
      events: ['push', 'create', 'delete', 'pull_request'],
    });
    expect(repository.teamsGranted).toBe(true);
  });
});

describe('the webhook gateway', () => {
  it('turns a signed push into an event, once per delivery', async () => {
    const setup = await setUp();
    const delivery = randomUUID();

    await push(setup, 'feature/login', 'a'.repeat(40)).set('X-Forgejo-Delivery', delivery).expect(204);
    await push(setup, 'feature/login', 'a'.repeat(40)).set('X-Forgejo-Delivery', delivery).expect(204);

    await eventually(async () => expect((await auditTypes(setup.admin)).filter((type) => type === 'CodePushed')).toHaveLength(1));
  });

  it('refuses a wrong signature and an unknown repository the same way', async () => {
    const setup = await setUp();

    const forged = await push(setup, 'feature/x', 'b'.repeat(40)).set('X-Forgejo-Signature', 'f'.repeat(64)).expect(401);
    await webhook(setup, 'push', { ref: 'refs/heads/x', before: ZERO, after: 'b'.repeat(40) }, { secret: 'guessed' }).expect(401);
    const unknown = await webhook(setup, 'push', { ref: 'refs/heads/x', before: ZERO, after: 'b'.repeat(40) }, {
      repository: 'someone/else',
    }).expect(401);

    expect(forged.body.detail).toBe(unknown.body.detail);
  });

  it("refuses another repository's secret", async () => {
    const first = await setUp();
    const second = await setUp();

    await webhook(second, 'push', { ref: 'refs/heads/x', before: ZERO, after: 'c'.repeat(40) }, {
      secret: webhookSecret(SECRET_KEY, first.applicationId),
    }).expect(401);
  });

  it('accepts and ignores events nothing reacts to, such as tag pushes', async () => {
    const setup = await setUp();

    await webhook(setup, 'push', { ref: 'refs/tags/v1.0.0', before: ZERO, after: 'd'.repeat(40) }).expect(204);
    await webhook(setup, 'issues', { action: 'opened' }).expect(204);
  });
});

describe('feature images', () => {
  it('are built, scanned, signed with the test key and listed as versions', async () => {
    const setup = await setUp();
    const commit = source.push(setup.organization, setup.name, 'feature/login');

    const { body: requested } = await setup.developer
      .post(`/api/v1/company/applications/${setup.applicationId}/feature-builds`)
      .send({ branch: 'feature/login' })
      .expect(201);
    expect(requested).toMatchObject({ kind: 'feature', status: 'queued', tag: `feature-login-${commit.slice(0, 7)}` });
    await runPipeline(requested.id);

    await eventually(async () => expect((await buildsOf(setup.developer, setup.applicationId))[0]?.status).toBe('succeeded'));
    const [build] = await buildsOf(setup.developer, setup.applicationId);
    const repository = `${setup.organization}/${setup.name}`;
    expect(build).toMatchObject({
      imageRef: `registry.test/${repository}:feature-login-${commit.slice(0, 7)}`,
      digest: registry.images.get(`${repository}:${build!.tag}`),
      signedWith: 'test',
    });
    const { body: keys } = await setup.viewer.get('/api/v1/company/signing-keys').expect(200);
    const testKey = (keys as { purpose: string; publicKey: string }[]).find((key) => key.purpose === 'test')!;
    const signature = registry.signatures.get(`${repository}@${build!.digest}`)!;
    expect(signature.payload).toEqual(signaturePayload(`registry.test/${repository}`, build!.digest!));
    expect(verifyPayload(testKey.publicKey, signature.payload, signature.signature)).toBe(true);
    const { body: versions } = await setup.viewer.get(`/api/v1/company/applications/${setup.applicationId}/versions`).expect(200);
    expect(versions.map((version: { id: string }) => version.id)).toEqual([build!.id]);
    const { body: sbom } = await setup.viewer.get(`/api/v1/company/builds/${build!.id}/sbom`).expect(200);
    expect(sbom.components).toHaveLength(2);
    expect(pipelines.runs.find((run) => run.inputs.build === build!.id)?.inputs.api).toBe('http://api.tools.test');
    const workflows = pipelines.pipelines.get(setup.organization)!;
    expect(workflows['build.yaml']).toContain('name: image');
    expect(workflows['check.yaml']).toContain('name: check');
    // The image runner's secret label is filled in; nothing else in the pipeline names it.
    expect(workflows['build.yaml']).toContain('runs-on: test-image-runner');
    expect(workflows['build.yaml']).not.toContain('__IMAGE_RUNNER_LABEL__');
    expect(workflows['check.yaml']).not.toContain('test-image-runner');
    expect(pipelines.runs.find((run) => run.inputs.build === build!.id)?.workflow).toBe('build.yaml');
    await eventually(async () => expect(await auditTypes(setup.admin)).toEqual(expect.arrayContaining(['BuildRequested', 'BuildSucceeded'])));
  });

  it('build only from existing feature branches, and only for developers and Tech Leads', async () => {
    const setup = await setUp();
    const builds = `/api/v1/company/applications/${setup.applicationId}/feature-builds`;

    await setup.developer.post(builds).send({ branch: 'develop' }).expect(400);
    await setup.developer.post(builds).send({ branch: 'feature/missing' }).expect(404);
    await setup.viewer.post(builds).send({ branch: 'feature/missing' }).expect(403);
  });

  it.each([
    [{ testsPass: false }, 'The tests failed.'],
    [{ secrets: [{ RuleID: 'aws-access-key', File: 'src/config.ts', StartLine: 3 }] }, 'Secrets were found in the code (1), in src/config.ts.'],
    [{ critical: 2 }, 'The image has 2 critical vulnerabilities.'],
  ])('fail when a gate fails: %j', async (options, reason) => {
    const setup = await setUp();
    source.push(setup.organization, setup.name, 'feature/gate');
    const { body } = await setup.developer
      .post(`/api/v1/company/applications/${setup.applicationId}/feature-builds`)
      .send({ branch: 'feature/gate' })
      .expect(201);

    await runPipeline(body.id, options);

    await eventually(async () =>
      expect((await buildsOf(setup.developer, setup.applicationId))[0]).toMatchObject({ status: 'failed', failureReason: reason }),
    );
    expect(registry.signatures.size === 0 || ![...registry.signatures.keys()].some((key) => key.includes(setup.name))).toBe(true);
    await setup.viewer.get(`/api/v1/company/applications/${setup.applicationId}/versions`).expect(200, []);
  });

  it('refuse pipeline calls without the right token, and after the build ends', async () => {
    const setup = await setUp();
    source.push(setup.organization, setup.name, 'feature/token');
    const { body } = await setup.developer
      .post(`/api/v1/company/applications/${setup.applicationId}/feature-builds`)
      .send({ branch: 'feature/token' })
      .expect(201);
    await eventually(() => expect(pipelines.tokenOf(body.id)).toBeDefined());

    await job(body.id, 'x'.repeat(43)).source().expect(401);
    await job(randomUUID(), pipelines.tokenOf(body.id)).source().expect(401);
    await runPipeline(body.id, { testsPass: false });
    await eventually(async () => expect((await buildsOf(setup.developer, setup.applicationId))[0]?.status).toBe('failed'));
    await job(body.id).source().expect(401);
  });

  it('show where each pipeline job stands while the build runs', async () => {
    const setup = await setUp();
    source.push(setup.organization, setup.name, 'feature/progress');
    const { body } = await setup.developer
      .post(`/api/v1/company/applications/${setup.applicationId}/feature-builds`)
      .send({ branch: 'feature/progress' })
      .expect(201);
    await eventually(() => expect(pipelines.tokenOf(body.id)).toBeDefined());
    const steps = job(body.id);
    const states = async () =>
      (await buildsOf(setup.developer, setup.applicationId))[0]!.progress.map(
        (step) => `${step.job}:${step.state}`,
      );
    expect(await states()).toEqual(['secrets:waiting', 'test:waiting', 'image:waiting', 'scan:waiting', 'sbom:waiting']);

    await steps.started('secrets').expect(204);
    await steps.started('test').expect(204);
    await steps.started('test').expect(204);
    await steps.report('secrets', '[]').expect(204);
    expect(await states()).toEqual(['secrets:passed', 'test:running', 'image:waiting', 'scan:waiting', 'sbom:waiting']);

    await steps.started('deploy').expect(404);
    await job(body.id, 'wrong-token-of-the-right-length-0000').started('image').expect(401);
    await steps.report('failure', 'secrets=success test=failure').expect(204);
    expect(await states()).toEqual(['secrets:passed', 'test:failed', 'image:skipped', 'scan:skipped', 'sbom:skipped']);
  });

  it('fail at once when a pipeline job dies without its report', async () => {
    const setup = await setUp();
    source.push(setup.organization, setup.name, 'feature/dies');
    const { body } = await setup.developer
      .post(`/api/v1/company/applications/${setup.applicationId}/feature-builds`)
      .send({ branch: 'feature/dies' })
      .expect(201);
    await eventually(() => expect(pipelines.tokenOf(body.id)).toBeDefined());

    await job(body.id).report('failure', 'secrets=success test=success image=success scan=failure sbom=success').expect(204);

    expect((await buildsOf(setup.developer, setup.applicationId))[0]).toMatchObject({
      status: 'failed',
      failureReason: 'The pipeline stopped: the vulnerability scan step failed.',
    });
  });

  it('refuse an image whose parts are missing or changed', async () => {
    const setup = await setUp();
    source.push(setup.organization, setup.name, 'feature/parts');
    const { body } = await setup.developer
      .post(`/api/v1/company/applications/${setup.applicationId}/feature-builds`)
      .send({ branch: 'feature/parts' })
      .expect(201);
    await eventually(() => expect(pipelines.tokenOf(body.id)).toBeDefined());
    const auth = { Authorization: `Bearer ${pipelines.tokenOf(body.id)}` };
    const base = `/api/v1/pipeline/builds/${body.id}/image`;
    const server = app.getHttpServer();
    await request(server).post(`${base}/parts/0`).set(auth).set('Content-Type', 'text/plain').send(Buffer.from('abc').toString('base64')).expect(204);

    await request(server).post(`${base}/complete?parts=2&sha256=${'0'.repeat(64)}`).set(auth).expect(400);
    await request(server).post(`${base}/parts/0`).set(auth).set('Content-Type', 'text/plain').send(Buffer.from('abc').toString('base64')).expect(204);
    await request(server).post(`${base}/complete?parts=1&sha256=${'0'.repeat(64)}`).set(auth).expect(400);
    await request(server).post(`${base}/parts/999`).set(auth).set('Content-Type', 'text/plain').send('YQ==').expect(400);
    expect(registry.images.size === 0 || ![...registry.images.keys()].some((key) => key.includes(setup.name))).toBe(true);
  });

  it('fail when their jobs never finish', async () => {
    const setup = await setUp();
    source.push(setup.organization, setup.name, 'feature/stuck');
    const { body } = await setup.developer
      .post(`/api/v1/company/applications/${setup.applicationId}/feature-builds`)
      .send({ branch: 'feature/stuck' })
      .expect(201);
    await eventually(() => expect(pipelines.tokenOf(body.id)).toBeDefined());
    const superuser = new pg.Pool({ connectionString: database.superuserUrl() });
    try {
      await superuser.query("UPDATE builds.builds SET created_at = now() - interval '2 hours' WHERE id = $1", [body.id]);
    } finally {
      await superuser.end();
    }

    await app.get(Builds).expireStale();

    expect((await buildsOf(setup.developer, setup.applicationId))[0]).toMatchObject({
      status: 'failed',
      failureReason: "The build didn't finish within 60 minutes.",
    });
  });

  it('are deleted when their branch is deleted', async () => {
    const setup = await setUp();
    const commit = source.push(setup.organization, setup.name, 'feature/gone');
    const { body } = await setup.developer
      .post(`/api/v1/company/applications/${setup.applicationId}/feature-builds`)
      .send({ branch: 'feature/gone' })
      .expect(201);
    await runPipeline(body.id);
    await eventually(async () => expect((await buildsOf(setup.developer, setup.applicationId))[0]?.status).toBe('succeeded'));

    await push(setup, 'feature/gone', ZERO, commit).expect(204);

    await eventually(async () => expect((await buildsOf(setup.developer, setup.applicationId))[0]?.status).toBe('deleted'));
    const deletedBuild = (await buildsOf(setup.developer, setup.applicationId))[0]!;
    expect(registry.deleted).toEqual(
      expect.arrayContaining([
        `${setup.organization}/${setup.name}:feature-gone-${commit.slice(0, 7)}`,
        // Its signature goes too, rather than staying behind in the registry.
        `${setup.organization}/${setup.name}:${deletedBuild.digest!.replace(':', '-')}.sig`,
      ]),
    );
    await setup.viewer.get(`/api/v1/company/applications/${setup.applicationId}/versions`).expect(200, []);
  });
});

describe('pull request checks', () => {
  const pullRequest = (setup: Setup, action: string, head: string, commit: string, base = 'develop') =>
    webhook(setup, 'pull_request', {
      action,
      number: 9,
      pull_request: { number: 9, head: { ref: head, sha: commit }, base: { ref: base } },
    });
  const statusesOf = (setup: Setup, commit: string) =>
    source.repositories
      .get(`${setup.organization}/${setup.name}`)!
      .statuses.filter((entry) => entry.commit === commit && entry.status.context === 'dreamdevops/tests')
      .map((entry) => entry.status.state);
  const checkFor = async (setup: Setup, commit: string) => {
    let found: Awaited<ReturnType<typeof buildsOf>>[number] | undefined;
    await eventually(async () => {
      found = (await buildsOf(setup.admin, setup.applicationId)).find(
        (build) => build.kind === 'check' && build.tag === `check-${commit}`,
      );
      expect(found).toBeDefined();
    });
    return found!;
  };
  const runCheck = async (buildId: string, testsPass: boolean) => {
    await eventually(() => expect(pipelines.tokenOf(buildId)).toBeDefined());
    const steps = job(buildId);
    await steps.report('secrets', '[]').expect(204);
    await steps.report('tests', testsPass ? 'ok' : 'expected 2 to be 3', `?passed=${testsPass}`).expect(204);
  };

  it("run the platform's tests on a pull request's newest commit, and report the result", async () => {
    const setup = await setUp();
    const commit = source.push(setup.organization, setup.name, 'feature/checked');

    await pullRequest(setup, 'opened', 'feature/checked', commit).expect(204);

    const check = await checkFor(setup, commit);
    await eventually(() =>
      expect(pipelines.runs.find((run) => run.inputs.build === check.id)?.workflow).toBe('check.yaml'),
    );
    await eventually(() => expect(statusesOf(setup, commit)).toContain('pending'));
    await runCheck(check.id, true);
    await eventually(() => expect(statusesOf(setup, commit).at(-1)).toBe('success'));
    // A check builds no image, so it's never a version.
    await setup.viewer.get(`/api/v1/company/applications/${setup.applicationId}/versions`).expect(200, []);
  });

  it('report failing tests on the commit, and check each new commit', async () => {
    const setup = await setUp();
    const first = source.push(setup.organization, setup.name, 'feature/flaky');
    await pullRequest(setup, 'opened', 'feature/flaky', first).expect(204);
    await runCheck((await checkFor(setup, first)).id, false);
    await eventually(() => expect(statusesOf(setup, first).at(-1)).toBe('failure'));

    const second = source.push(setup.organization, setup.name, 'feature/flaky');
    await pullRequest(setup, 'synchronized', 'feature/flaky', second).expect(204);
    await runCheck((await checkFor(setup, second)).id, true);

    await eventually(() => expect(statusesOf(setup, second).at(-1)).toBe('success'));
  });

  it('report a commit checked before without running it again', async () => {
    const setup = await setUp();
    const commit = source.push(setup.organization, setup.name, 'feature/again');
    await pullRequest(setup, 'opened', 'feature/again', commit).expect(204);
    const check = await checkFor(setup, commit);
    await runCheck(check.id, true);
    await eventually(() => expect(statusesOf(setup, commit).at(-1)).toBe('success'));
    const runs = pipelines.runs.length;

    await pullRequest(setup, 'reopened', 'feature/again', commit).expect(204);

    await eventually(() => expect(statusesOf(setup, commit).filter((state) => state === 'success')).toHaveLength(2));
    expect(pipelines.runs.length).toBe(runs);
  });
});

describe('a release', () => {
  const releasesOf = async (agent: Agent, applicationId: string) =>
    (await agent.get(`/api/v1/company/applications/${applicationId}/releases`).expect(200)).body as {
      releases: {
        id: string;
        status: string;
        candidates: { number: number; tag: string; commit: string; buildStatus: string | null }[];
        mergeBackPullRequest: number | null;
        finalBuildStatus: string | null;
      }[];
      suggestions: { release: string; hotfix: string };
    };

  it('goes from release branch to RC images, merge, final image and merge back', async () => {
    const setup = await setUp();
    const repository = source.repositories.get(`${setup.organization}/${setup.name}`)!;
    expect((await releasesOf(setup.viewer, setup.applicationId)).suggestions).toEqual({ release: '0.1.0', hotfix: '0.0.1' });

    await setup.techLead
      .post(`/api/v1/company/applications/${setup.applicationId}/releases`)
      .send({ kind: 'release', version: '0.1.0' })
      .expect(201);

    // The branch is cut from develop, and its newest commit becomes release candidate 1.
    await eventually(() => expect(repository.tags.get('v0.1.0-rc.1')).toBe(repository.branches.get('develop')));
    expect(repository.branches.get('release/0.1.0')).toBe(repository.branches.get('develop'));
    await eventually(() =>
      expect(repository.pullRequests).toContainEqual(
        expect.objectContaining({ head: 'release/0.1.0', base: 'main', title: 'Release 0.1.0' }),
      ),
    );
    const firstCommit = repository.tags.get('v0.1.0-rc.1')!;
    // The status is reported just after the tag, and the build is asked for after that.
    await eventually(() =>
      expect(repository.statuses).toContainEqual({
        commit: firstCommit,
        status: expect.objectContaining({ context: 'dreamdevops/rc-image', state: 'pending' }),
      }),
    );
    let rc = await buildTagged(setup, '0.1.0-rc.1');
    await runPipeline(rc.id);
    await eventually(() =>
      expect(repository.statuses).toContainEqual({
        commit: firstCommit,
        status: expect.objectContaining({ context: 'dreamdevops/rc-image', state: 'success' }),
      }),
    );

    // A fix merged into the release branch becomes candidate 2.
    const fix = source.push(setup.organization, setup.name, 'release/0.1.0');
    await push(setup, 'release/0.1.0', fix, firstCommit).expect(204);
    await eventually(() => expect(repository.tags.get('v0.1.0-rc.2')).toBe(fix));
    rc = await buildTagged(setup, '0.1.0-rc.2');
    expect(rc.signedWith).toBeNull();
    await runPipeline(rc.id);
    await eventually(async () =>
      expect((await buildsOf(setup.techLead, setup.applicationId)).find((build) => build.id === rc.id)?.signedWith).toBe('test'),
    );

    // Merging into main tags the version, builds the final image and opens the merge back.
    const mergeCommit = source.push(setup.organization, setup.name, 'main');
    await webhook(setup, 'pull_request', {
      action: 'closed',
      number: 1,
      pull_request: { number: 1, merged: true, merge_commit_sha: mergeCommit, head: { ref: 'release/0.1.0' }, base: { ref: 'main' } },
    }).expect(204);
    await eventually(() => expect(repository.tags.get('v0.1.0')).toBe(mergeCommit));
    await eventually(async () => expect((await buildsOf(setup.techLead, setup.applicationId)).some((build) => build.kind === 'final')).toBe(true));
    const final = (await buildsOf(setup.techLead, setup.applicationId)).find((build) => build.kind === 'final')!;
    expect(final.tag).toBe('0.1.0');
    await runPipeline(final.id);

    // The merge back is opened while the final image builds, so either can finish first.
    await eventually(async () =>
      expect((await releasesOf(setup.viewer, setup.applicationId)).releases[0]).toMatchObject({
        status: 'published',
        // Pull request 1 is the release's own, into main.
        mergeBackPullRequest: 2,
        finalBuildStatus: 'succeeded',
      }),
    );
    const [release] = (await releasesOf(setup.viewer, setup.applicationId)).releases;
    expect(release!.candidates.map((candidate) => [candidate.tag, candidate.buildStatus])).toEqual([
      ['v0.1.0-rc.2', 'succeeded'],
      ['v0.1.0-rc.1', 'succeeded'],
    ]);
    expect(repository.pullRequests).toContainEqual(expect.objectContaining({ head: 'main', base: 'develop' }));
    const finalBuild = (await buildsOf(setup.techLead, setup.applicationId)).find((build) => build.kind === 'final')!;
    expect(finalBuild.signedWith).toBe('release');
    expect((await releasesOf(setup.viewer, setup.applicationId)).suggestions).toEqual({ release: '0.2.0', hotfix: '0.1.1' });
    await eventually(async () =>
      expect(await auditTypes(setup.admin)).toEqual(
        expect.arrayContaining(['ReleaseStarted', 'ReleaseCandidateCreated', 'ReleaseMerged', 'ReleasePublished']),
      ),
    );
  });

  it('needs a higher version, one open release at a time, and a Tech Lead', async () => {
    const setup = await setUp();
    const releases = `/api/v1/company/applications/${setup.applicationId}/releases`;

    await setup.techLead.post(releases).send({ kind: 'release', version: '1.0.0' }).expect(201);
    await setup.techLead.post(releases).send({ kind: 'release', version: '1.1.0' }).expect(409);
    // A hotfix ships before the open release, so it must be lower.
    const higher = await setup.techLead.post(releases).send({ kind: 'hotfix', version: '1.0.0' }).expect(409);
    expect(higher.body.detail).toBe('Version 1.0.0 is already used.');
    await setup.techLead.post(releases).send({ kind: 'hotfix', version: '1.0.1' }).expect(409);
    await setup.techLead.post(releases).send({ kind: 'release', version: 'one' }).expect(400);
    await setup.developer.post(releases).send({ kind: 'release', version: '2.0.0' }).expect(403);
    // A hotfix can run alongside a release, from main.
    await setup.techLead.post(releases).send({ kind: 'hotfix', version: '0.9.1' }).expect(201);
    const repository = source.repositories.get(`${setup.organization}/${setup.name}`)!;
    await eventually(() => expect(repository.branches.get('hotfix/0.9.1')).toBe(repository.branches.get('main')));
  });

  it('ignores merges into main from other branches', async () => {
    const setup = await setUp();
    const repository = source.repositories.get(`${setup.organization}/${setup.name}`)!;

    await webhook(setup, 'pull_request', {
      action: 'closed',
      number: 7,
      pull_request: { number: 7, merged: true, merge_commit_sha: 'e'.repeat(40), head: { ref: 'feature/x' }, base: { ref: 'main' } },
    }).expect(204);

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect([...repository.tags.keys()]).toEqual([]);
  });
});
