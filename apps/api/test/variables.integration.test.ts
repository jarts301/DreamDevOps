import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Agent,
  createEnvironment,
  deployed,
  developmentImage,
  environment,
  harness,
  local,
  resetHosts,
  setUp,
  startDeploymentWorld,
  stepOf,
  stopDeploymentWorld,
  type World,
} from './support/deployments.ts';

beforeAll(startDeploymentWorld, 180_000);
afterAll(stopDeploymentWorld);
beforeEach(resetHosts);

interface Variable {
  id: string;
  environmentId: string;
  name: string;
  secret: boolean;
  value: string | null;
  version: number;
  updatedBy: { displayName: string | null } | null;
}

const SECRET = 'postgres://billing:fake-dummy-database-password@db.internal/billing';
const REASON = 'Pointing production at the new database.';

const variables = async (agent: Agent, environmentId: string) =>
  (await agent.get(`/api/v1/company/environments/${environmentId}/variables`).expect(200)).body as Variable[];

const add = (agent: Agent, environmentId: string, body: object) =>
  agent.post(`/api/v1/company/environments/${environmentId}/variables`).send(body);

const added = async (agent: Agent, environmentId: string, body: object) =>
  (await add(agent, environmentId, body).expect(201)).body as Variable;

/** Runs work as the app's database role, in the company, as row-level security requires. */
const asCompany = async <T>(world: World, work: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: harness.database.urlFor('app') });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [world.companyId]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } finally {
    await client.end();
  }
};

describe('variables and secrets', () => {
  it('are kept per environment: values of variables for every member, and only names of secrets', async () => {
    const world = await setUp();
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    const other = await createEnvironment(world, world.techLead, { name: 'Development' });

    const plain = await added(world.operator, staging.id, { name: 'LOG_LEVEL', value: 'debug' });
    const secret = await added(world.techLead, staging.id, { name: 'DATABASE_URL', value: SECRET, secret: true });

    expect(plain).toMatchObject({ name: 'LOG_LEVEL', secret: false, value: 'debug', version: 1 });
    expect(secret).toMatchObject({ name: 'DATABASE_URL', secret: true, value: null, version: 1 });
    const listed = await variables(world.viewer, staging.id);
    expect(listed.map((variable) => [variable.name, variable.secret, variable.value])).toEqual([
      ['DATABASE_URL', true, null],
      ['LOG_LEVEL', false, 'debug'],
    ]);
    expect(listed[0]!.updatedBy?.displayName).toEqual(expect.any(String));
    expect(await variables(world.viewer, other.id)).toEqual([]);
    expect(await environment(world, staging.id)).toMatchObject({ variables: 2 });
    await add(world.developer, staging.id, { name: 'MINE', value: 'x' }).expect(403);
  });

  it('never keep or publish a value in the clear where it could leak', async () => {
    const world = await setUp();
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    await added(world.techLead, staging.id, { name: 'DATABASE_URL', value: SECRET, secret: true });
    await added(world.techLead, staging.id, { name: 'FEATURE_FLAGS', value: 'fake-dummy-plain-value' });

    const rows = await asCompany(world, async (client) => {
      const stored = await client.query<{ name: string; value: string | null; ciphertext: Buffer | null; key_id: string | null }>(
        'SELECT name, value, ciphertext, key_id FROM environments.variables WHERE environment_id = $1 ORDER BY name',
        [staging.id],
      );
      const events = await client.query<{ payload: object }>(
        "SELECT payload FROM kernel.outbox WHERE event_type LIKE 'EnvironmentVariable%'",
      );
      return { stored: stored.rows, events: events.rows };
    });

    const [sealed] = rows.stored;
    expect(sealed).toMatchObject({ name: 'DATABASE_URL', value: null, key_id: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(sealed!.ciphertext!.toString('utf8')).not.toContain('fake-dummy-database-password');
    expect(rows.events).toHaveLength(2);
    expect(JSON.stringify(rows.events)).not.toMatch(/fake-dummy-(database-password|plain-value)/);
    expect(rows.events[0]!.payload).toMatchObject({ name: 'DATABASE_URL', secret: true, change: 'added', production: false });
  });

  it('change with the version they were based on, stay secret, and can be removed', async () => {
    const world = await setUp();
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    const secret = await added(world.techLead, staging.id, { name: 'API_KEY', value: 'fake-dummy-one', secret: true });

    await world.techLead.patch(`/api/v1/company/variables/${secret.id}`).send({ value: 'fake-dummy-two', version: 2 }).expect(409);
    const { body: changed } = await world.techLead
      .patch(`/api/v1/company/variables/${secret.id}`)
      .send({ value: 'fake-dummy-two', version: 1, secret: false, name: 'OTHER' })
      .expect(200);

    // Neither its name nor whether it's secret can change: only its value.
    expect(changed).toMatchObject({ name: 'API_KEY', secret: true, value: null, version: 2 });
    await world.techLead.delete(`/api/v1/company/variables/${secret.id}`).send({ version: 1 }).expect(409);
    await world.techLead.delete(`/api/v1/company/variables/${secret.id}`).send({ version: 2 }).expect(204);
    expect(await variables(world.viewer, staging.id)).toEqual([]);
    await world.techLead.delete(`/api/v1/company/variables/${secret.id}`).send({ version: 2 }).expect(404);
  });

  it('refuse names taken in another case, the platform’s names, and values on several lines', async () => {
    const world = await setUp();
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    await added(world.techLead, staging.id, { name: 'LOG_LEVEL', value: 'info' });

    const { body: taken } = await add(world.techLead, staging.id, { name: 'log_level', value: 'debug' }).expect(409);
    expect(taken.detail).toBe('Staging already has LOG_LEVEL. Change it instead.');
    const { body: reserved } = await add(world.techLead, staging.id, { name: 'DREAMDEVOPS_VERSION', value: '1' }).expect(400);
    expect(reserved.detail).toContain('is set by the platform');
    const { body: lines } = await add(world.techLead, staging.id, { name: 'KEY', value: 'a\nb', secret: true }).expect(400);
    expect(lines.detail).toBe('Values must fit on one line. Encode multi-line values, such as keys, in base64.');
  });

  it('of production need people who manage production, its name typed and a reason', async () => {
    const world = await setUp();
    const production = await createEnvironment(world, world.techLead, { name: 'Production', production: true });
    const change = { name: 'DATABASE_URL', value: SECRET, secret: true };

    await add(world.admin, production.id, { ...change, confirmation: 'Production', reason: REASON }).expect(403);
    const { body } = await add(world.techLead, production.id, change).expect(400);
    expect(body.detail).toBe('This affects production. To confirm, type its name exactly: Production');
    await add(world.techLead, production.id, { ...change, confirmation: 'Production' }).expect(400);

    const secret = await added(world.techLead, production.id, { ...change, confirmation: 'Production', reason: REASON });

    await world.operator.delete(`/api/v1/company/variables/${secret.id}`).send({ version: 1 }).expect(400);
    await world.operator
      .delete(`/api/v1/company/variables/${secret.id}`)
      .send({ version: 1, confirmation: 'Production', reason: REASON })
      .expect(204);
    const events = await asCompany(world, async (client) =>
      (
        await client.query<{ event_type: string; payload: { reason: string; production: boolean } }>(
          "SELECT event_type, payload FROM kernel.outbox WHERE event_type LIKE 'EnvironmentVariable%' ORDER BY sequence",
        )
      ).rows,
    );
    expect(events.map((event) => [event.event_type, event.payload.production, event.payload.reason])).toEqual([
      ['EnvironmentVariableSet', true, REASON],
      ['EnvironmentVariableRemoved', true, REASON],
    ]);
  });

  it('aren’t changed in an archived environment, nor seen or changed by another company', async () => {
    const world = await setUp();
    const other = await setUp();
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    const variable = await added(world.techLead, staging.id, { name: 'LOG_LEVEL', value: 'info' });

    await other.techLead.get(`/api/v1/company/environments/${staging.id}/variables`).expect(404);
    await add(other.techLead, staging.id, { name: 'MINE', value: 'x' }).expect(404);
    await other.techLead.patch(`/api/v1/company/variables/${variable.id}`).send({ value: 'x', version: 1 }).expect(404);
    await other.techLead.delete(`/api/v1/company/variables/${variable.id}`).send({ version: 1 }).expect(404);

    await world.techLead.post(`/api/v1/company/environments/${staging.id}/archive`).send({ version: staging.version }).expect(200);
    const { body } = await add(world.techLead, staging.id, { name: 'OTHER', value: 'x' }).expect(409);
    expect(body.detail).toBe('Restore the environment first.');
  });
});

describe('when a container starts', () => {
  it('gets every variable and secret, and the platform’s own, read at that moment', async () => {
    const world = await setUp();
    const image = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    await added(world.techLead, staging.id, { name: 'LOG_LEVEL', value: 'debug' });
    await added(world.techLead, staging.id, { name: 'DATABASE_URL', value: SECRET, secret: true });

    const done = await deployed(world.developer, staging.id, { buildId: image.id });

    expect(done.status).toBe('succeeded');
    expect(local.environmentOf(staging.target!.id)).toEqual({
      DATABASE_URL: SECRET,
      LOG_LEVEL: 'debug',
      DREAMDEVOPS_ENVIRONMENT: 'staging',
      DREAMDEVOPS_PRODUCTION: 'false',
      DREAMDEVOPS_VERSION: image.version,
    });
    expect(stepOf(done, 'start').facts).toEqual(
      expect.arrayContaining([
        { label: 'Variables', value: 'LOG_LEVEL' },
        { label: 'Secrets', value: 'DATABASE_URL' },
      ]),
    );
    // Nothing people can read holds a secret's value.
    expect(JSON.stringify(done)).not.toContain('fake-dummy-database-password');
    expect(await environment(world, staging.id)).toMatchObject({ settingsPending: false });
  });

  it('applies changes the next time a version starts, and says they’re waiting meanwhile', async () => {
    const world = await setUp();
    const image = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    const level = await added(world.techLead, staging.id, { name: 'LOG_LEVEL', value: 'info' });
    await deployed(world.developer, staging.id, { buildId: image.id });

    await world.techLead.patch(`/api/v1/company/variables/${level.id}`).send({ value: 'debug', version: 1 }).expect(200);

    expect(await environment(world, staging.id)).toMatchObject({ settingsPending: true, live: { buildId: image.id } });
    expect(local.environmentOf(staging.target!.id)?.['LOG_LEVEL']).toBe('info');

    await deployed(world.developer, staging.id, { buildId: image.id });

    expect(local.environmentOf(staging.target!.id)?.['LOG_LEVEL']).toBe('debug');
    expect(await environment(world, staging.id)).toMatchObject({ settingsPending: false });
  });

  it('doesn’t start when a secret can’t be read, and the version before keeps running', async () => {
    const world = await setUp();
    const first = await developmentImage(world);
    const second = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    await added(world.techLead, staging.id, { name: 'DATABASE_URL', value: SECRET, secret: true });
    await deployed(world.developer, staging.id, { buildId: first.id });
    // Someone changed the sealed value in the database, outside DreamDevOps.
    await asCompany(world, (client) =>
      client.query("UPDATE environments.variables SET ciphertext = decode('00112233', 'hex') WHERE environment_id = $1", [staging.id]),
    );

    const failed = await deployed(world.developer, staging.id, { buildId: second.id });

    expect(failed.status).toBe('failed');
    expect(stepOf(failed, 'start')).toMatchObject({
      status: 'failed',
      summary: 'A secret can’t be read, so nothing was started.',
      checks: [
        {
          name: 'Its secrets can be read',
          outcome: 'failed',
          detail: "DATABASE_URL can't be read: it was changed outside DreamDevOps. Set it again.",
        },
      ],
    });
    expect((await environment(world, staging.id)).live?.version).toBe(first.version);
    expect(local.running(staging.target!.id)).toHaveLength(1);
  });
});
