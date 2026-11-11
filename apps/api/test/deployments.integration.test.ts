import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditTypes,
  createEnvironment,
  type Deployment,
  deploy,
  deployed,
  developmentImage,
  digestOf,
  dockerHost,
  environment,
  type Environment,
  eventually,
  finished,
  local,
  type Option,
  registry,
  releaseImages,
  resetHosts,
  setUp,
  startDeploymentWorld,
  stepOf,
  stopDeploymentWorld,
  harness,
} from './support/deployments.ts';

beforeAll(startDeploymentWorld, 180_000);
afterAll(stopDeploymentWorld);
beforeEach(resetHosts);

describe('deploying to an environment', () => {
  it('runs a version on this machine by default, step by step, and says where to reach it', async () => {
    const world = await setUp();
    const image = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });

    const { body: options } = await world.developer.get(`/api/v1/company/environments/${staging.id}/versions`).expect(200);
    expect(options).toEqual([
      expect.objectContaining({ buildId: image.id, version: image.version, kind: 'development', productive: false, problem: null, live: false }),
    ]);

    const { body: queued } = await deploy(world.developer, staging.id, { buildId: image.id, reason: 'Trying the CSV export' }).expect(202);
    expect(queued).toMatchObject({
      number: 1,
      kind: 'deploy',
      status: 'queued',
      version: image.version,
      imageKind: 'development',
      image: digestOf(image),
      production: false,
      target: { name: 'This machine', provider: { key: 'local' } },
      reason: 'Trying the CSV export',
      requestedBy: { displayName: expect.any(String) },
    });
    expect((queued as Deployment).steps.map((step) => `${step.key}:${step.status}`)).toEqual([
      'validate:pending',
      'verify:pending',
      'pull:pending',
      'start:pending',
      'health:pending',
    ]);

    const done = await finished(world.developer, (queued as Deployment).id);

    expect(done.status).toBe('succeeded');
    expect(done.steps.every((step) => step.status === 'passed')).toBe(true);
    expect(stepOf(done, 'validate').checks.map((check) => `${check.outcome}: ${check.name}`)).toEqual([
      'passed: The environment is active',
      'passed: It still runs on this hosting target',
      'passed: The hosting target is active',
      'passed: The platform can deploy to this host',
      'passed: The image was built, published and signed',
      'passed: Production runs only releases',
    ]);
    expect(stepOf(done, 'verify').checks.every((check) => check.outcome === 'passed')).toBe(true);
    expect(done.address).toMatch(/^http:\/\/localhost:\d+$/);
    expect(stepOf(done, 'health').facts).toEqual([{ label: 'Address', value: done.address }]);
    expect(stepOf(done, 'start').facts).toContainEqual({ label: 'Limits', value: '1 CPU and 512 MiB of memory' });
    const running = local.running((await environment(world, staging.id)).target!.id);
    expect(running).toEqual([{ name: expect.stringMatching(/^dreamdevops-.+-staging-[0-9a-f]{12}$/), image: digestOf(image), port: expect.any(Number) }]);
    expect(await environment(world, staging.id)).toMatchObject({
      live: { deploymentId: done.id, version: image.version, productive: false, address: done.address, target: { name: 'This machine' } },
      deploying: null,
    });
    await eventually(async () => {
      expect(await auditTypes(world.admin)).toEqual(expect.arrayContaining(['DeploymentQueued', 'DeploymentSucceeded']));
    });
  });

  it('keeps the address, and removes the version before only once the new one is healthy', async () => {
    const world = await setUp();
    const first = await developmentImage(world);
    const second = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    const before = await deployed(world.developer, staging.id, { buildId: first.id });

    const after = await deployed(world.developer, staging.id, { buildId: second.id });

    expect(after).toMatchObject({ status: 'succeeded', number: 2, address: before.address });
    expect(stepOf(after, 'start').summary).toBe(
      `Started ${second.version}. The version before it is kept, stopped, until this one is healthy.`,
    );
    const targetId = (await environment(world, staging.id)).target!.id;
    expect(local.running(targetId).map((container) => container.image)).toEqual([digestOf(second)]);
    expect([...local.containers.keys()].filter((key) => key.startsWith(targetId))).toHaveLength(1);
    const { body: history } = await world.viewer.get(`/api/v1/company/environments/${staging.id}/deployments`).expect(200);
    expect((history as Deployment[]).map((deployment) => deployment.version)).toEqual([second.version, first.version]);
  });

  it('rolls back a version that doesn’t become healthy, so the one before runs again', async () => {
    const world = await setUp();
    const good = await developmentImage(world);
    const broken = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    await deployed(world.developer, staging.id, { buildId: good.id });
    local.unhealthy.add(digestOf(broken));

    const failed = await deployed(world.developer, staging.id, { buildId: broken.id });

    expect(failed.status).toBe('failed');
    expect(stepOf(failed, 'health')).toMatchObject({
      status: 'failed',
      summary: `${broken.version} didn’t become healthy. Rolled back: ${good.version} runs again.`,
      checks: [{ name: 'It became healthy', outcome: 'failed', detail: expect.stringContaining('connection refused') }],
    });
    expect(await environment(world, staging.id)).toMatchObject({ live: { version: good.version } });
    const targetId = (await environment(world, staging.id)).target!.id;
    expect(local.running(targetId).map((container) => container.image)).toEqual([digestOf(good)]);
    await eventually(async () => {
      const entries = ((await world.admin.get('/api/v1/company/audit').expect(200)).body.entries as { eventType: string; payload: Record<string, unknown> }[]).filter(
        (entry) => entry.eventType === 'DeploymentFailed',
      );
      expect(entries[0]?.payload).toMatchObject({ step: 'Wait until it’s healthy', stillRunning: good.version });
    });
  });

  it('runs nothing whose signature doesn’t check out', async () => {
    const world = await setUp();
    const image = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    // Someone replaced the signatures in the registry.
    registry.stored.set(digestOf(image), []);
    const pulls = local.calls.length;

    const failed = await deployed(world.developer, staging.id, { buildId: image.id });

    expect(failed.status).toBe('failed');
    expect(stepOf(failed, 'verify')).toMatchObject({
      status: 'failed',
      summary: 'The signature doesn’t check out, so the image won’t run.',
    });
    expect(stepOf(failed, 'pull').status).toBe('pending');
    expect(local.calls.slice(pulls)).toEqual([]);
    expect((await environment(world, staging.id)).live).toBeNull();
  });

  it('tries again after a temporary problem, such as Docker restarting', async () => {
    const world = await setUp();
    const image = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    local.failures.push(new Error('Cannot connect to the Docker daemon'));

    const done = await deployed(world.developer, staging.id, { buildId: image.id });

    expect(done).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('is refused on a host that can’t run it, with the reason', async () => {
    const world = await setUp();
    const image = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    local.enabled = false;

    const { body } = await deploy(world.developer, staging.id, { buildId: image.id }).expect(409);

    expect(body.detail).toBe('Running applications on this host is turned off.');
  });

  it('runs one deployment per environment at a time', async () => {
    const world = await setUp();
    const image = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    const release = local.hold();
    try {
      const { body: first } = await deploy(world.developer, staging.id, { buildId: image.id }).expect(202);
      await eventually(async () => expect((await environment(world, staging.id)).deploying).toMatchObject({ id: first.id }));

      const { body } = await deploy(world.developer, staging.id, { buildId: image.id }).expect(409);

      expect(body.detail).toBe('A deployment to Staging is already in progress. Wait for it to finish.');
    } finally {
      release();
    }
  });

  it('is only for people who deploy, and only of the application’s own images', async () => {
    const world = await setUp();
    const other = await setUp();
    const image = await developmentImage(world);
    const theirs = await developmentImage(other);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });

    await deploy(world.viewer, staging.id, { buildId: image.id }).expect(403);
    await deploy(world.admin, staging.id, { buildId: image.id }).expect(403);
    const { body } = await deploy(world.developer, staging.id, { buildId: theirs.id }).expect(400);
    expect(body.detail).toBe("Choose one of this application's versions that built, published and signed.");
    await other.developer.get(`/api/v1/company/environments/${staging.id}/deployments`).expect(404);
    await deploy(other.developer, staging.id, { buildId: theirs.id }).expect(404);
  });
});

describe('production', () => {
  it('runs only releases, deployed by people who deploy to production, with its name typed', async () => {
    const world = await setUp();
    const development = await developmentImage(world);
    const { candidate, release } = await releaseImages(world);
    const production = await createEnvironment(world, world.techLead, { name: 'Production', production: true });

    const { body: options } = await world.techLead.get(`/api/v1/company/environments/${production.id}/versions`).expect(200);
    const byVersion = new Map((options as Option[]).map((option) => [option.version, option]));
    expect(byVersion.get(release.version)).toMatchObject({ kind: 'release', productive: true, problem: null });
    expect(byVersion.get(candidate.version)?.problem).toBe(
      `Production is a production environment, so it runs only releases. ${candidate.version} is a release candidate.`,
    );
    expect(byVersion.get(development.version)?.problem).toBe(
      `Production is a production environment, so it runs only releases. ${development.version} is a development image.`,
    );

    const { body: refused } = await deploy(world.techLead, production.id, { buildId: candidate.id, confirmation: 'Production' }).expect(409);
    expect(refused.detail).toContain('so it runs only releases');
    await deploy(world.developer, production.id, { buildId: release.id, confirmation: 'Production' }).expect(403);
    const { body: unconfirmed } = await deploy(world.techLead, production.id, { buildId: release.id }).expect(400);
    expect(unconfirmed.detail).toBe('This deploys to production. To confirm, type its name exactly: Production');

    const done = await deployed(world.operator, production.id, { buildId: release.id, confirmation: 'Production' });

    expect(done).toMatchObject({ status: 'succeeded', production: true, productive: true, imageKind: 'release' });
    expect(stepOf(done, 'validate').checks.at(-1)).toEqual({
      name: 'Production runs only releases',
      outcome: 'passed',
      detail: `${release.version} is a release.`,
    });
    expect((await environment(world, production.id)).live).toMatchObject({ version: release.version, productive: true });
  });

  it('can’t be made of an environment that runs a candidate', async () => {
    const world = await setUp();
    const { candidate, release } = await releaseImages(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    await deployed(world.techLead, staging.id, { buildId: candidate.id });

    const { body } = await world.techLead
      .post(`/api/v1/company/environments/${staging.id}/protect`)
      .send({ version: staging.version })
      .expect(409);

    expect(body.detail).toBe(
      `Staging runs ${candidate.version}, which is a release candidate. Production runs only releases, so deploy a release to it, or stop it, first.`,
    );
    await deployed(world.techLead, staging.id, { buildId: release.id });
    await world.techLead.post(`/api/v1/company/environments/${staging.id}/protect`).send({ version: staging.version }).expect(200);
  });

  it('is kept to releases by the database too, if a bug ever got past the API', async () => {
    const world = await setUp();
    const development = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    await deployed(world.developer, staging.id, { buildId: development.id });
    const client = new pg.Client({ connectionString: harness.database.urlFor('app') });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [world.companyId]);
      await expect(client.query('UPDATE environments.environments SET production = true WHERE id = $1', [staging.id])).rejects.toThrow(
        'Production environments run only releases.',
      );
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('is stopped only with its name typed and a reason', async () => {
    const world = await setUp();
    const { release } = await releaseImages(world);
    const production = await createEnvironment(world, world.techLead, { name: 'Production', production: true });
    await deployed(world.techLead, production.id, { buildId: release.id, confirmation: 'Production' });

    await world.developer.post(`/api/v1/company/environments/${production.id}/stop`).send({}).expect(403);
    const { body } = await world.operator
      .post(`/api/v1/company/environments/${production.id}/stop`)
      .send({ confirmation: 'Production' })
      .expect(400);
    expect(body.detail).toContain('Say why');

    const { body: queued } = await world.operator
      .post(`/api/v1/company/environments/${production.id}/stop`)
      .send({ confirmation: 'Production', reason: 'Moving customers to the new service.' })
      .expect(202);
    const stopped = await finished(world.operator, (queued as Deployment).id);

    expect(stopped).toMatchObject({ kind: 'stop', status: 'succeeded', version: release.version });
    expect(stopped.steps.map((step) => step.key)).toEqual(['validate', 'stop']);
    expect((await environment(world, production.id)).live).toBeNull();
    expect(local.running((await environment(world, production.id)).target!.id)).toEqual([]);
  });
});

describe('changing where an environment runs', () => {
  it('moves what runs to the new host, then removes it from the old one', async () => {
    const world = await setUp();
    const image = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    const before = await deployed(world.developer, staging.id, { buildId: image.id });
    const server = (
      await world.operator
        .post('/api/v1/company/hosting-targets')
        .send({ name: 'Office server', provider: 'docker', settings: { host: 'docker-01.example.com' } })
        .expect(201)
    ).body as { id: string };

    const { body: switched } = await world.techLead
      .patch(`/api/v1/company/environments/${staging.id}`)
      .send({ version: staging.version, targetId: server.id })
      .expect(200);

    expect(switched).toMatchObject({ target: { id: server.id }, deploying: { status: 'queued' }, live: { target: { name: 'This machine' } } });
    const moved = await finished(world.techLead, (switched as Environment).deploying!.id);
    expect(moved).toMatchObject({
      kind: 'move',
      status: 'succeeded',
      version: image.version,
      target: { id: server.id, name: 'Office server' },
      previousTarget: { id: before.target.id, name: 'This machine' },
    });
    expect(moved.steps.map((step) => step.key)).toEqual(['validate', 'verify', 'pull', 'start', 'health', 'retire']);
    expect(stepOf(moved, 'retire').summary).toBe('Removed it from This machine.');
    expect(dockerHost.running(server.id).map((container) => container.image)).toEqual([digestOf(image)]);
    expect(local.running(before.target.id)).toEqual([]);
    expect((await environment(world, staging.id)).live).toMatchObject({ target: { id: server.id, name: 'Office server' } });
  });

  it('refuses to move what runs somewhere it can’t run, or by someone who doesn’t deploy', async () => {
    const world = await setUp();
    const image = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    await deployed(world.developer, staging.id, { buildId: image.id });
    const cloud = (
      await world.operator
        .post('/api/v1/company/hosting-targets')
        .send({ name: 'AWS Ireland', provider: 'aws', settings: { accountId: '123456789012', region: 'eu-west-1' } })
        .expect(201)
    ).body as { id: string };

    const { body: nowhere } = await world.techLead
      .patch(`/api/v1/company/environments/${staging.id}`)
      .send({ version: staging.version, targetId: cloud.id })
      .expect(409);
    expect(nowhere.detail).toBe(
      `Staging runs ${image.version}, so it can only move where it can run. Deploying to Amazon Web Services targets isn’t available yet.`,
    );
    // Company Admins manage environments, but don't deploy.
    const { body: forbidden } = await world.admin
      .patch(`/api/v1/company/environments/${staging.id}`)
      .send({ version: staging.version, targetId: null })
      .expect(403);
    expect(forbidden.detail).toContain('moving it deploys it again');
    // Renaming doesn't move anything, so it's fine.
    await world.admin.patch(`/api/v1/company/environments/${staging.id}`).send({ version: staging.version, name: 'Test' }).expect(200);
  });
});

describe('what runs', () => {
  it('keeps an environment and its target from being archived until it’s stopped', async () => {
    const world = await setUp();
    const image = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    await deployed(world.developer, staging.id, { buildId: image.id });
    const current = await environment(world, staging.id);

    const { body: environmentRefused } = await world.techLead
      .post(`/api/v1/company/environments/${staging.id}/archive`)
      .send({ version: current.version })
      .expect(409);
    expect(environmentRefused.detail).toBe(`Staging runs ${image.version}. Stop it before archiving the environment.`);
    const { body: targets } = await world.operator.get('/api/v1/company/hosting-targets').expect(200);
    const machine = (targets as { id: string; version: number; running: number; provider: { key: string } }[]).find(
      (target) => target.provider.key === 'local',
    )!;
    expect(machine.running).toBe(1);

    const { body: stopQueued } = await world.developer.post(`/api/v1/company/environments/${staging.id}/stop`).send({}).expect(202);
    await finished(world.developer, (stopQueued as Deployment).id);

    await world.techLead.post(`/api/v1/company/environments/${staging.id}/archive`).send({ version: current.version }).expect(200);
    await world.operator.post(`/api/v1/company/hosting-targets/${machine.id}/archive`).send({ version: machine.version }).expect(200);
  });
});
