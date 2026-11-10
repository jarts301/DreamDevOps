import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_PROVIDER } from '../src/identity-access/application/ports.ts';
import { GIT_PROVIDER } from '../src/tenancy/application/ports.ts';
import { FakeGitProvider, FakeIdentityProvider } from './fakes.ts';
import { type Agent, eventually, signIn as signInAs, unique } from './support/integration.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';

let database: TestDatabase;
let ownerPool: pg.Pool;
let app: INestApplication;

const signIn = (user: string) => signInAs(app, user);

interface Environment {
  id: string;
  name: string;
  slug: string;
  production: boolean;
  status: string;
  version: number;
  target: { id: string; name: string; provider: { key: string; kind: string; deploys: boolean } } | null;
}

interface Target {
  id: string;
  name: string;
  version: number;
  environments: number;
  servesProduction: boolean;
  provider: { key: string; name: string; kind: string };
  settings: Record<string, unknown>;
}

const addMember = async (admin: Agent, role: string) => {
  const name = unique(role);
  const { body } = await admin.post('/api/v1/company/invitations').send({ email: `${name}@example.com`, role }).expect(201);
  const agent = await signIn(name);
  await agent.post('/api/v1/invitations/accept').send({ token: body.token }).expect(200);
  return agent;
};

/** A company with an application, and one person in each role. */
const setUp = async () => {
  const platformAdmin = await signIn('platform-admin');
  const adminName = unique('admin');
  const { body } = await platformAdmin
    .post('/api/v1/platform/companies')
    .send({ name: unique('Company'), firstAdminEmail: `${adminName}@example.com` })
    .expect(201);
  const admin = await signIn(adminName);
  await admin.post('/api/v1/invitations/accept').send({ token: body.invitation.token }).expect(200);
  const { body: application } = await admin
    .post('/api/v1/company/applications')
    .send({ name: unique('Billing'), type: 'restful-service' })
    .expect(201);
  return {
    admin,
    techLead: await addMember(admin, 'tech-lead'),
    operator: await addMember(admin, 'operator'),
    developer: await addMember(admin, 'developer'),
    companyId: body.company.id as string,
    applicationId: application.id as string,
    applicationName: application.name as string,
  };
};
type World = Awaited<ReturnType<typeof setUp>>;

const connect = async (agent: Agent, provider: string, settings: object, name = unique('Target')) =>
  (await agent.post('/api/v1/company/hosting-targets').send({ name, provider, settings }).expect(201)).body as Target;

const selfHosted = (agent: Agent) => connect(agent, 'kubernetes', { apiServerUrl: 'https://k8s.example.com:6443' });
const cloud = (agent: Agent) => connect(agent, 'aws', { accountId: '123456789012', region: 'eu-west-1' });

const create = async (world: World, agent: Agent, input: object) =>
  (await agent.post(`/api/v1/company/applications/${world.applicationId}/environments`).send(input).expect(201))
    .body as Environment;

const environmentsOf = async (world: World, status = 'active') =>
  (await world.developer.get(`/api/v1/company/applications/${world.applicationId}/environments?status=${status}`).expect(200))
    .body as Environment[];

/** Events saved for the company, read as the app role in its context, as row-level security requires. */
const outbox = async (world: World, prefix: string) => {
  const client = new pg.Client({ connectionString: database.urlFor('app') });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [world.companyId]);
    const { rows } = await client.query<{ event_type: string; payload: Record<string, unknown> }>(
      'SELECT event_type, payload FROM kernel.outbox WHERE event_type LIKE $1 ORDER BY sequence',
      [`${prefix}%`],
    );
    await client.query('ROLLBACK');
    return rows;
  } finally {
    await client.end();
  }
};

/** A production environment on a self-hosted target, made by the Tech Lead. */
const withProduction = async () => {
  const world = await setUp();
  const target = await selfHosted(world.operator);
  const production = await create(world, world.techLead, { name: 'Production', production: true, targetId: target.id });
  return { world, target, production };
};

const REASON = 'Moving production to the new cloud account.';

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
    ],
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await ownerPool?.end();
  await database?.stop();
});

describe('hosting targets', () => {
  it('are connected by Company Admins and Operators, from any provider, with checked settings', async () => {
    const world = await setUp();

    const own = await connect(world.operator, 'docker', { host: 'Docker-01.Example.com' }, 'Office server');
    const rented = await connect(world.admin, 'gcp', { projectId: 'acme-production', region: 'europe-west1' });

    expect(own).toMatchObject({
      name: 'Office server',
      provider: { key: 'docker', name: 'Docker host', kind: 'self-hosted' },
      settings: { host: 'docker-01.example.com', sshPort: 22 },
      version: 1,
      environments: 0,
      servesProduction: false,
    });
    expect(rented.provider.kind).toBe('cloud');
    await world.techLead.post('/api/v1/company/hosting-targets').send({}).expect(403);
    await world.developer.post('/api/v1/company/hosting-targets').send({}).expect(403);
    const { body: listed } = await world.developer.get('/api/v1/company/hosting-targets').expect(200);
    // Every company also has a target for the machine that runs DreamDevOps.
    expect(listed.map((target: Target) => target.name).sort()).toEqual([own.name, rented.name, 'This machine'].sort());
  });

  it('include one for this machine, which every company gets once, and may archive', async () => {
    const world = await setUp();

    const { body: listed } = await world.developer.get('/api/v1/company/hosting-targets').expect(200);
    const local = (listed as Target[]).find((target) => target.provider.key === 'local')!;

    expect(local).toMatchObject({
      name: 'This machine',
      provider: { key: 'local', name: 'This machine', kind: 'self-hosted', deploys: true },
      settings: {},
      version: 1,
    });
    const [connected] = await outbox(world, 'HostingTargetConnected');
    expect(connected?.payload).toEqual({ targetId: local.id, name: 'This machine', provider: 'local' });
    const second = { name: 'Second machine', provider: 'local', settings: {} };
    const { body: refused } = await world.operator.post('/api/v1/company/hosting-targets').send(second).expect(409);
    expect(refused.detail).toBe('The company already has a target for this machine.');

    await world.operator.post(`/api/v1/company/hosting-targets/${local.id}/archive`).send({ version: 1 }).expect(200);

    // Once archived, it stays archived, and new environments wait for someone to choose.
    const { body: after } = await world.developer.get('/api/v1/company/hosting-targets').expect(200);
    expect((after as Target[]).some((target) => target.provider.key === 'local')).toBe(false);
    expect((await create(world, world.techLead, { name: 'Staging' })).target).toBeNull();
    const { body: again } = await world.operator.post('/api/v1/company/hosting-targets').send(second).expect(409);
    expect(again.detail).toBe('The company already has an archived target for this machine. Restore it instead.');
  });

  it('refuse unknown providers, bad settings and taken names', async () => {
    const world = await setUp();
    const post = (body: object) => world.operator.post('/api/v1/company/hosting-targets').send(body);

    expect((await post({ name: 'Mystery', provider: 'mainframe', settings: {} }).expect(400)).body.detail).toBe(
      'Choose one of the hosting providers.',
    );
    expect((await post({ name: 'AWS', provider: 'aws', settings: { accountId: '1', region: 'eu-west-1' } }).expect(400)).body.detail).toBe(
      "The account ID isn't valid. For example: 123456789012.",
    );
    await connect(world.operator, 'aws', { accountId: '123456789012', region: 'eu-west-1' }, 'AWS');
    await post({ name: 'aws', provider: 'aws', settings: { accountId: '123456789012', region: 'eu-west-1' } }).expect(409);
  });

  it('can be archived only when no environment runs on them', async () => {
    const world = await setUp();
    const target = await selfHosted(world.operator);
    const staging = await create(world, world.techLead, { name: 'Staging', targetId: target.id });

    const { body } = await world.operator
      .post(`/api/v1/company/hosting-targets/${target.id}/archive`)
      .send({ version: 1 })
      .expect(409);
    expect(body.detail).toBe('1 environment runs on this target. Move it to another target first.');

    await world.techLead.patch(`/api/v1/company/environments/${staging.id}`).send({ version: 1, targetId: null }).expect(200);
    const archived = (await world.operator.post(`/api/v1/company/hosting-targets/${target.id}/archive`).send({ version: 1 }).expect(200))
      .body as Target;
    expect(archived).toMatchObject({ status: 'archived', version: 2 });
    await world.techLead
      .patch(`/api/v1/company/environments/${staging.id}`)
      .send({ version: 2, targetId: target.id })
      .expect(400);
  });
});

describe('environments', () => {
  it('are created per application, with short names for their infrastructure, non-production first', async () => {
    const world = await setUp();
    const target = await selfHosted(world.operator);

    await create(world, world.techLead, { name: 'Production', production: true, targetId: target.id });
    const staging = await create(world, world.admin, { name: 'User Acceptance', targetId: target.id });
    const development = await create(world, world.operator, { name: 'Development' });
    const unplaced = await create(world, world.operator, { name: 'Later', targetId: null });

    expect(staging).toMatchObject({
      slug: 'user-acceptance',
      production: false,
      version: 1,
      target: { id: target.id, provider: { key: 'kubernetes', kind: 'self-hosted' } },
    });
    // Without a choice, an environment runs on this machine. Choosing none leaves it for later.
    expect(development.target).toMatchObject({ name: 'This machine', provider: { key: 'local', kind: 'self-hosted', deploys: true } });
    expect(unplaced.target).toBeNull();
    expect((await environmentsOf(world)).map((environment) => environment.name)).toEqual([
      'Development',
      'Later',
      'User Acceptance',
      'Production',
    ]);
    await world.developer
      .post(`/api/v1/company/applications/${world.applicationId}/environments`)
      .send({ name: 'Mine' })
      .expect(403);
    await world.techLead
      .post(`/api/v1/company/applications/${world.applicationId}/environments`)
      .send({ name: 'development' })
      .expect(409);
  });

  it('move between hosting targets, such as from a self-hosted cluster to a cloud', async () => {
    const world = await setUp();
    const ownCluster = await selfHosted(world.operator);
    const account = await cloud(world.operator);
    const staging = await create(world, world.techLead, { name: 'Staging', targetId: ownCluster.id });

    const moved = (await world.techLead
      .patch(`/api/v1/company/environments/${staging.id}`)
      .send({ version: staging.version, targetId: account.id })
      .expect(200)).body as Environment;

    expect(moved).toMatchObject({ version: 2, target: { id: account.id, provider: { key: 'aws', kind: 'cloud' } } });
    const [switched] = await outbox(world, 'EnvironmentTargetSwitched');
    expect(switched?.payload).toMatchObject({
      environmentId: staging.id,
      applicationName: world.applicationName,
      targetId: account.id,
      provider: 'aws',
      previousTargetId: ownCluster.id,
      previousProvider: 'kubernetes',
      production: false,
      reason: null,
    });
  });

  it('refuse a change based on an older version, so nobody overwrites what they haven’t seen', async () => {
    const world = await setUp();
    const staging = await create(world, world.techLead, { name: 'Staging' });

    await world.techLead.patch(`/api/v1/company/environments/${staging.id}`).send({ version: 1, name: 'Testing' }).expect(200);
    const { body } = await world.operator
      .patch(`/api/v1/company/environments/${staging.id}`)
      .send({ version: 1, name: 'QA' })
      .expect(409);

    expect(body.detail).toBe('Someone else changed this meanwhile. Reload it and try again.');
    expect((await environmentsOf(world))[0]?.name).toBe('Testing');
    await world.techLead.patch(`/api/v1/company/environments/${staging.id}`).send({ name: 'QA' }).expect(400);
  });

  it('are archived and restored, and keep their names meanwhile', async () => {
    const world = await setUp();
    const staging = await create(world, world.techLead, { name: 'Staging' });

    await world.techLead.post(`/api/v1/company/environments/${staging.id}/archive`).send({ version: 1 }).expect(200);
    expect(await environmentsOf(world)).toEqual([]);
    expect((await environmentsOf(world, 'archived')).map((environment) => environment.name)).toEqual(['Staging']);
    await world.techLead
      .post(`/api/v1/company/applications/${world.applicationId}/environments`)
      .send({ name: 'Staging' })
      .expect(409);
    await world.techLead.post(`/api/v1/company/environments/${staging.id}/restore`).send({ version: 2 }).expect(200);
  });

  it('are not created for an archived application', async () => {
    const world = await setUp();
    await world.admin.post(`/api/v1/company/applications/${world.applicationId}/archive`).expect(204);

    await world.techLead
      .post(`/api/v1/company/applications/${world.applicationId}/environments`)
      .send({ name: 'Staging' })
      .expect(409);
  });
});

describe('production environments', () => {
  it('are created, or made, only by people who manage production', async () => {
    const world = await setUp();

    const { body } = await world.admin
      .post(`/api/v1/company/applications/${world.applicationId}/environments`)
      .send({ name: 'Production', production: true })
      .expect(403);
    expect(body.detail).toBe('Only people who manage production can do this.');
    const staging = await create(world, world.admin, { name: 'Staging' });
    await world.admin.post(`/api/v1/company/environments/${staging.id}/protect`).send({ version: 1 }).expect(403);

    const protectedOne = (await world.operator
      .post(`/api/v1/company/environments/${staging.id}/protect`)
      .send({ version: 1, reason: 'Staging now serves the beta customers.' })
      .expect(200)).body as Environment;
    expect(protectedOne).toMatchObject({ production: true, version: 2 });
    expect((await outbox(world, 'EnvironmentProtected'))[0]?.payload).toMatchObject({
      reason: 'Staging now serves the beta customers.',
      production: true,
    });
  });

  it('can’t be renamed or moved by a slip: they need their name typed exactly and a reason', async () => {
    const { world, production } = await withProduction();
    const account = await cloud(world.operator);
    const change = (body: object) =>
      world.techLead.patch(`/api/v1/company/environments/${production.id}`).send({ version: 1, targetId: account.id, ...body });

    expect((await change({}).expect(400)).body.detail).toBe(
      'This affects production. To confirm, type its name exactly: Production',
    );
    await change({ confirmation: 'production', reason: REASON }).expect(400);
    expect((await change({ confirmation: 'Production' }).expect(400)).body.detail).toBe(
      "Say why you're changing production, in 10 to 500 characters.",
    );
    expect((await environmentsOf(world))[0]?.target?.provider.key).toBe('kubernetes');

    const moved = (await change({ confirmation: 'Production', reason: REASON }).expect(200)).body as Environment;

    expect(moved.target?.provider.key).toBe('aws');
    expect((await outbox(world, 'EnvironmentTargetSwitched'))[0]?.payload).toMatchObject({ production: true, reason: REASON });
  });

  it('can’t be changed by people who manage environments but not production, even when confirmed', async () => {
    const { world, production } = await withProduction();

    const { body } = await world.admin
      .patch(`/api/v1/company/environments/${production.id}`)
      .send({ version: 1, name: 'Live', confirmation: 'Production', reason: REASON })
      .expect(403);

    expect(body.detail).toBe('Only people who manage production can do this.');
  });

  it('can’t be archived until their protection is removed, which is itself protected', async () => {
    const { world, production } = await withProduction();
    const archive = (version: number) =>
      world.operator.post(`/api/v1/company/environments/${production.id}/archive`).send({ version });

    expect((await archive(1).expect(409)).body.detail).toBe(
      'Remove the production protection before archiving this environment.',
    );
    await world.operator.post(`/api/v1/company/environments/${production.id}/unprotect`).send({ version: 1 }).expect(400);
    await world.admin
      .post(`/api/v1/company/environments/${production.id}/unprotect`)
      .send({ version: 1, confirmation: 'Production', reason: REASON })
      .expect(403);
    await world.operator
      .post(`/api/v1/company/environments/${production.id}/unprotect`)
      .send({ version: 1, confirmation: 'Production', reason: 'Retiring the old setup for good.' })
      .expect(200);
    await archive(2).expect(200);

    await eventually(async () => {
      const { body } = await world.admin.get('/api/v1/company/audit').expect(200);
      const unprotected = (body.entries as { eventType: string; payload: { reason?: string } }[]).find(
        (entry) => entry.eventType === 'EnvironmentUnprotected',
      );
      expect(unprotected?.payload.reason).toBe('Retiring the old setup for good.');
    });
  });

  it('protect the hosting targets they run on', async () => {
    const { world, target } = await withProduction();
    const change = (agent: Agent, body: object) =>
      agent.patch(`/api/v1/company/hosting-targets/${target.id}`).send({ version: 1, settings: { apiServerUrl: 'https://k8s-2.example.com' }, ...body });

    expect((await world.developer.get('/api/v1/company/hosting-targets').expect(200)).body[0]).toMatchObject({
      servesProduction: true,
      environments: 1,
    });
    expect((await change(world.admin, {}).expect(403)).body.detail).toBe('Only people who manage production can do this.');
    expect((await change(world.operator, {}).expect(400)).body.detail).toBe(
      `This affects production. To confirm, type its name exactly: ${target.name}`,
    );

    const updated = (await change(world.operator, { confirmation: target.name, reason: REASON }).expect(200)).body as Target;

    expect(updated).toMatchObject({ version: 2, settings: { apiServerUrl: 'https://k8s-2.example.com' } });
    expect((await outbox(world, 'HostingTargetUpdated'))[0]?.payload).toMatchObject({ servesProduction: true, reason: REASON });
  });

  it('are protected by the database too, if a bug ever got past the API', async () => {
    const { world, production } = await withProduction();
    const client = new pg.Client({ connectionString: database.urlFor('app') });
    await client.connect();
    const asApp = async (sql: string) => {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [world.companyId]);
      try {
        await client.query(sql, [production.id]);
      } finally {
        await client.query('ROLLBACK');
      }
    };
    try {
      await expect(asApp('DELETE FROM environments.environments WHERE id = $1')).rejects.toThrow(/permission denied/);
      await expect(asApp("UPDATE environments.environments SET status = 'archived' WHERE id = $1")).rejects.toThrow(
        /production_not_archived/,
      );
      await expect(asApp('UPDATE environments.environments SET slug = $1 WHERE id = $1')).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
  });
});

describe('company separation', () => {
  it('keeps each company’s environments and targets apart', async () => {
    const first = await setUp();
    const second = await setUp();
    const theirTarget = await selfHosted(first.operator);
    const theirs = await create(first, first.techLead, { name: 'Staging', targetId: theirTarget.id });

    await second.techLead.get(`/api/v1/company/applications/${first.applicationId}/environments`).expect(404);
    await second.techLead.patch(`/api/v1/company/environments/${theirs.id}`).send({ version: 1, name: 'Mine' }).expect(404);
    await second.operator.patch(`/api/v1/company/hosting-targets/${theirTarget.id}`).send({ version: 1, name: 'Mine' }).expect(404);
    const { body } = await second.techLead
      .post(`/api/v1/company/applications/${second.applicationId}/environments`)
      .send({ name: 'Staging', targetId: theirTarget.id })
      .expect(400);
    expect(body.detail).toBe("Choose one of the company's active hosting targets.");
    const { body: listed } = await second.developer.get('/api/v1/company/hosting-targets').expect(200);
    expect(listed.map((target: Target) => target.name)).toEqual(['This machine']);
    expect(listed[0].id).not.toBe(theirTarget.id);
  });
});
