import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AlertChecks, type CheckSummary } from '../src/alerts/application/alert-checks.ts';
import { MAILER } from '../src/notifications/application/ports.ts';
import type { FakeMailer } from './fakes.ts';
import {
  type Agent,
  auditTypes,
  createEnvironment,
  deployed,
  developmentImage,
  eventually,
  harness,
  resetHosts,
  setUp,
  startDeploymentWorldWith,
  stopDeploymentWorld,
  type World,
} from './support/deployments.ts';
import { HttpStub, type RecordedRequest } from './support/http-stub.ts';
import { eventually as waitUntil } from './support/integration.ts';

// A stub stands in for Prometheus. It answers each query with the values `cpu` holds for
// the environments the query names, and a working value for every other metric.
const prometheus = new HttpStub();
const cpu = new Map<string, string>();
let prometheusDown = false;

const queryOf = (recorded: RecordedRequest) =>
  new URLSearchParams(typeof recorded.body === 'string' ? recorded.body : '').get('query') ?? '';
const environmentsIn = (query: string) => /dreamdevops_environment_id=~?"([^"]+)"/.exec(query)?.[1]!.split('|') ?? [];

beforeAll(async () => {
  await prometheus.start();
  prometheus.on('POST', '/api/v1/query', (recorded) => {
    if (prometheusDown) {
      return { status: 503, body: { status: 'error', error: 'unavailable' } };
    }
    const query = queryOf(recorded);
    return {
      body: {
        status: 'success',
        data: {
          resultType: 'vector',
          result: environmentsIn(query).flatMap((id) => {
            const value = query.includes('process_cpu_time_seconds_total') ? cpu.get(id) : '1';
            return value === undefined ? [] : [{ metric: { dreamdevops_environment_id: id }, value: [Date.now() / 1000, value] }];
          }),
        },
      },
    };
  });
  await startDeploymentWorldWith({ prometheusUrl: prometheus.url, notificationRetrySeconds: 1 });
}, 180_000);

afterAll(async () => {
  await stopDeploymentWorld();
  await prometheus.stop();
});

beforeEach(() => {
  resetHosts();
  cpu.clear();
  prometheusDown = false;
});

const mailer = () => harness.app.get<FakeMailer>(MAILER);
/** The alert emails sent to an address. Members got their invitations there too, which don't count. */
const emailsTo = (address: string) =>
  mailer().sent.filter((email) => email.to === address && /^\[(Firing|Resolved|Test)\] /.test(email.subject));

/** Checks the company's alerts now, as the minute's scheduled check would. */
const checkNow = (world: World): Promise<CheckSummary> =>
  runWithCompany(parseCompanyId(world.companyId), () => harness.app.get(AlertChecks).check());

/** Who an agent is, as an alert names them. */
interface Person {
  userId: string;
  displayName: string;
  email: string;
}

const whoIs = async (agent: Agent): Promise<Person> => {
  const { body } = await agent.get('/api/v1/auth/me').expect(200);
  return { userId: body.userId, displayName: body.displayName, email: body.email };
};

/** A company with an application that runs in Staging, and who its operator, tech lead and viewer are. */
const running = async () => {
  const world = await setUp();
  const image = await developmentImage(world);
  const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
  await deployed(world.developer, staging.id, { buildId: image.id });
  const [operator, techLead, viewer] = await Promise.all([whoIs(world.operator), whoIs(world.techLead), whoIs(world.viewer)]);
  return { world, staging, people: { operator, techLead, viewer } };
};

interface Alert {
  id: string;
  name: string;
  environmentId: string;
  environmentName: string | null;
  applicationName: string | null;
  condition: string;
  recipients: Person[] | null;
  recipientCount: number;
  enabled: boolean;
  state: string;
  firingSince: string | null;
  lastValue: number | null;
  checkProblem: string | null;
  lastNotificationError: string | null;
}

const alertsOf = async (agent: Agent) => (await agent.get('/api/v1/company/alerts').expect(200)).body as { metricsEnabled: boolean; alerts: Alert[] };

/** The members an alert names, as saved, read as the API reads them, in the company. */
const storedRecipients = async (world: World, alertId: string): Promise<string[]> => {
  const client = new pg.Client({ connectionString: harness.database.urlFor('app') });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [world.companyId]);
    const { rows } = await client.query<{ recipient_ids: string[] }>('SELECT recipient_ids FROM alerts.alerts WHERE id = $1', [alertId]);
    await client.query('COMMIT');
    return rows[0]!.recipient_ids;
  } finally {
    await client.end();
  }
};

/** Creates an alert that emails these members. */
const createAlert = async (agent: Agent, environmentId: string, recipients: Person[], overrides: object = {}) =>
  (
    await agent
      .post('/api/v1/company/alerts')
      .send({
        name: 'High CPU',
        environmentId,
        metric: 'cpu',
        comparator: 'above',
        threshold: 80,
        forMinutes: 0,
        recipients: recipients.map((person) => person.userId),
        ...overrides,
      })
      .expect(201)
  ).body as Alert;

describe('alerts', () => {
  it('watch an environment’s metric, and email the members they name when it fires and when it’s resolved', async () => {
    const { world, staging, people } = await running();
    const { operator, techLead } = people;
    const alert = await createAlert(world.operator, staging.id, [operator, techLead]);

    expect(alert).toMatchObject({
      name: 'High CPU',
      environmentId: staging.id,
      environmentName: 'Staging',
      condition: 'CPU above 80%',
      recipients: [operator, techLead],
      recipientCount: 2,
      enabled: true,
      state: 'ok',
    });

    cpu.set(staging.id, '92.5');
    expect(await checkNow(world)).toEqual({ checked: 1, triggered: 1, resolved: 0, problem: null });

    await eventually(() => {
      expect(emailsTo(operator.email)).toHaveLength(1);
      expect(emailsTo(techLead.email)).toHaveLength(1);
    });
    const [firing] = emailsTo(operator.email);
    expect(firing!.subject).toBe(`[Firing] High CPU: ${alert.applicationName} in Staging`);
    expect(firing!.text).toContain('for CPU above 80%.');
    expect(firing!.text).toContain('Latest value: 93%');
    expect(firing!.text).toContain('http://dashboard.test/alerts');
    const [listed] = (await alertsOf(world.viewer)).alerts;
    expect(listed).toMatchObject({ state: 'firing', lastValue: 92.5, firingSince: expect.any(String) });

    // Still past the threshold: nobody is emailed again.
    expect(await checkNow(world)).toMatchObject({ triggered: 0, resolved: 0 });

    cpu.set(staging.id, '10');
    expect(await checkNow(world)).toMatchObject({ triggered: 0, resolved: 1 });

    await eventually(() => expect(emailsTo(operator.email)).toHaveLength(2));
    expect(emailsTo(operator.email)[1]!.subject).toBe(`[Resolved] High CPU: ${alert.applicationName} in Staging`);
    expect(emailsTo(operator.email)[1]!.text).toContain('Latest value: 10%');
    await eventually(async () => expect(emailsTo(techLead.email)).toHaveLength(2));
    expect((await alertsOf(world.viewer)).alerts[0]).toMatchObject({ state: 'ok', firingSince: null, lastNotificationError: null });

    const { body: incidents } = await world.viewer.get('/api/v1/company/alerts/incidents').expect(200);
    expect(incidents).toEqual([
      expect.objectContaining({
        alertId: alert.id,
        alertName: 'High CPU',
        environmentName: 'Staging',
        condition: 'CPU above 80%',
        startValue: '93%',
        resolvedAt: expect.any(String),
        endValue: '10%',
        endedBy: 'recovered',
      }),
    ]);
    await eventually(async () =>
      expect(await auditTypes(world.admin)).toEqual(expect.arrayContaining(['AlertCreated', 'AlertTriggered', 'AlertResolved'])),
    );
  });

  it('never email someone removed from the company, and take them off every alert', async () => {
    const { world, staging, people } = await running();
    const { operator, viewer } = people;
    const alert = await createAlert(world.operator, staging.id, [operator, viewer]);
    expect(await storedRecipients(world, alert.id)).toEqual([operator.userId, viewer.userId]);

    await world.admin.delete(`/api/v1/company/members/${viewer.userId}`).expect(204);

    // Taken off as the removal is heard, and shown without them meanwhile.
    await eventually(async () => expect(await storedRecipients(world, alert.id)).toEqual([operator.userId]));
    expect((await alertsOf(world.operator)).alerts[0]).toMatchObject({ recipients: [operator], recipientCount: 1 });

    cpu.set(staging.id, '95');
    await checkNow(world);
    await eventually(() => expect(emailsTo(operator.email)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(emailsTo(viewer.email)).toEqual([]);

    // Nor can they be chosen again while they're not a member.
    const { body } = await world.operator
      .patch(`/api/v1/company/alerts/${alert.id}`)
      .send({ recipients: [operator.userId, viewer.userId] })
      .expect(400);
    expect(body.detail).toBe('Choose members of the company to email. Someone chosen isn’t a member.');
  });

  it('offer the company’s members to email, and no one else', async () => {
    const [{ world, people }, theirs] = await Promise.all([running(), setUp()]);
    const stranger = await whoIs(theirs.operator);

    const { body } = await world.operator.get('/api/v1/company/alerts/members').expect(200);

    expect(body).toEqual(expect.arrayContaining([people.operator, people.techLead, people.viewer]));
    expect(body).toHaveLength(5);
    expect(body.map((person: Person) => person.userId)).not.toContain(stranger.userId);
    await world.viewer.get('/api/v1/company/alerts/members').expect(403);
  });

  it('wait until the metric has stayed past the threshold for their minutes', async () => {
    const { world, staging, people } = await running();
    await createAlert(world.techLead, staging.id, [people.techLead], { forMinutes: 5 });
    cpu.set(staging.id, '95');

    expect(await checkNow(world)).toMatchObject({ triggered: 0 });

    expect((await alertsOf(world.viewer)).alerts[0]).toMatchObject({ state: 'pending', lastValue: 95 });
    expect(emailsTo(people.techLead.email)).toEqual([]);
  });

  it('show whom they email only to those who manage them, and let only them make changes', async () => {
    const { world, staging, people } = await running();
    const alert = await createAlert(world.operator, staging.id, [people.operator]);

    expect((await alertsOf(world.viewer)).alerts[0]).toMatchObject({ recipients: null, recipientCount: 1 });
    expect((await alertsOf(world.admin)).alerts[0]!.recipients).toEqual([people.operator]);
    await world.developer.post('/api/v1/company/alerts').send({}).expect(403);
    await world.viewer.patch(`/api/v1/company/alerts/${alert.id}`).send({ enabled: false }).expect(403);
    await world.developer.delete(`/api/v1/company/alerts/${alert.id}`).expect(403);
  });

  it('stay within their company', async () => {
    const [{ world: ours, staging, people }, theirs] = await Promise.all([running(), setUp()]);
    const alert = await createAlert(ours.operator, staging.id, [people.operator]);
    const theirAdmin = await whoIs(theirs.admin);

    expect((await alertsOf(theirs.admin)).alerts).toEqual([]);
    await theirs.admin.patch(`/api/v1/company/alerts/${alert.id}`).send({ threshold: 90 }).expect(404);
    await theirs.admin.delete(`/api/v1/company/alerts/${alert.id}`).expect(404);
    await theirs.admin.post(`/api/v1/company/alerts/${alert.id}/test`).expect(404);
    const { body } = await theirs.admin
      .post('/api/v1/company/alerts')
      .send({ name: 'Theirs', environmentId: staging.id, metric: 'cpu', comparator: 'above', threshold: 1, forMinutes: 0, recipients: [theirAdmin.userId] })
      .expect(404);
    expect(body.detail).toBe('There’s no such environment.');
    // Nor can an alert email another company's members.
    await ours.operator
      .post('/api/v1/company/alerts')
      .send({ name: 'Leaky', environmentId: staging.id, metric: 'cpu', comparator: 'above', threshold: 1, forMinutes: 0, recipients: [theirAdmin.userId] })
      .expect(400);
  });

  it('take a new threshold from the next check, and end their incident quietly when turned off', async () => {
    const { world, staging, people } = await running();
    const address = people.operator.email;
    const alert = await createAlert(world.operator, staging.id, [people.operator]);
    cpu.set(staging.id, '85');
    await checkNow(world);
    await eventually(() => expect(emailsTo(address)).toHaveLength(1));

    const { body: raised } = await world.operator.patch(`/api/v1/company/alerts/${alert.id}`).send({ threshold: 90 }).expect(200);
    expect(raised).toMatchObject({ threshold: 90, condition: 'CPU above 90%', state: 'firing' });
    expect(await checkNow(world)).toMatchObject({ resolved: 1 });
    await eventually(() => expect(emailsTo(address)).toHaveLength(2));

    cpu.set(staging.id, '99');
    await checkNow(world);
    await eventually(() => expect(emailsTo(address)).toHaveLength(3));
    const { body: off } = await world.operator.patch(`/api/v1/company/alerts/${alert.id}`).send({ enabled: false }).expect(200);
    expect(off).toMatchObject({ enabled: false, state: 'ok', firingSince: null });
    expect(await checkNow(world)).toMatchObject({ checked: 0 });

    const { body: incidents } = await world.viewer.get('/api/v1/company/alerts/incidents').expect(200);
    expect(incidents.map((incident: { endedBy: string }) => incident.endedBy)).toEqual(['turned-off', 'recovered']);
    // Nobody is told it ended when it was turned off, as nothing was checked.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(emailsTo(address)).toHaveLength(3);
    await world.operator.patch(`/api/v1/company/alerts/${alert.id}`).send({ comparator: 'below' }).expect(400);
  });

  it('keep their state, and say why, when the metrics can’t be read', async () => {
    const { world, staging, people } = await running();
    await createAlert(world.operator, staging.id, [people.operator]);
    cpu.set(staging.id, '95');
    await checkNow(world);

    prometheusDown = true;
    const summary = await checkNow(world);

    expect(summary.problem).toMatch(/metrics store couldn’t answer/);
    expect((await alertsOf(world.viewer)).alerts[0]).toMatchObject({ state: 'firing', checkProblem: summary.problem });
    prometheusDown = false;
    await checkNow(world);
    expect((await alertsOf(world.viewer)).alerts[0]).toMatchObject({ state: 'firing', checkProblem: null });
  });

  it('resolve when nothing runs any more, as there’s nothing past the threshold', async () => {
    const { world, staging, people } = await running();
    await createAlert(world.operator, staging.id, [people.operator]);
    cpu.set(staging.id, '95');
    await checkNow(world);

    cpu.delete(staging.id);
    expect(await checkNow(world)).toMatchObject({ resolved: 1 });
    expect((await alertsOf(world.viewer)).alerts[0]).toMatchObject({ state: 'ok', lastValue: null });
  });

  it('have names of their own, and can be deleted with their history', async () => {
    const { world, staging, people } = await running();
    const alert = await createAlert(world.operator, staging.id, [people.operator]);
    const { body } = await world.operator
      .post('/api/v1/company/alerts')
      .send({ name: 'high cpu', environmentId: staging.id, metric: 'memory', comparator: 'above', threshold: 1, forMinutes: 0, recipients: [people.operator.userId] })
      .expect(409);
    expect(body.detail).toBe('Another alert already has this name.');
    cpu.set(staging.id, '95');
    await checkNow(world);

    await world.operator.delete(`/api/v1/company/alerts/${alert.id}`).expect(204);

    expect((await alertsOf(world.viewer)).alerts).toEqual([]);
    expect((await world.viewer.get('/api/v1/company/alerts/incidents').expect(200)).body).toEqual([]);
    await eventually(async () => expect(await auditTypes(world.admin)).toContain('AlertDeleted'));
  });

  it('send a test email to every member it names, straight away', async () => {
    const { world, staging, people } = await running();
    const alert = await createAlert(world.operator, staging.id, [people.techLead]);
    const address = people.techLead.email;

    const { body } = await world.operator.post(`/api/v1/company/alerts/${alert.id}/test`).expect(200);

    expect(body).toEqual({ delivered: true, sent: 1, error: null });
    expect(emailsTo(address)[0]!.subject).toBe(`[Test] High CPU: ${alert.applicationName} in Staging`);
    expect(emailsTo(address)[0]!.text).toContain('Latest value: Not checked yet');
    mailer().failing = true;
    try {
      const { body: failed } = await world.operator.post(`/api/v1/company/alerts/${alert.id}/test`).expect(200);
      expect(failed).toEqual({ delivered: false, sent: 0, error: 'Mail server unavailable' });
      expect((await alertsOf(world.operator)).alerts[0]!.lastNotificationError).toBe('Mail server unavailable');
    } finally {
      mailer().failing = false;
    }
  });

  it('are checked only for active companies with an alert that’s on', async () => {
    const [{ world: watching, staging, people }, idle] = await Promise.all([running(), setUp()]);
    await createAlert(watching.operator, staging.id, [people.operator]);

    const due = await harness.app.get(AlertChecks).companiesToCheck();

    expect(due).toContain(watching.companyId);
    expect(due).not.toContain(idle.companyId);
  });

  it('are checked every minute on their own, on a schedule every API process shares', async () => {
    const jobs = new pg.Pool({ connectionString: harness.database.urlFor('jobs'), max: 1 });
    try {
      const { rows } = await jobs.query("SELECT cron, timezone FROM pgboss.schedule WHERE name = 'alerts.check'");
      expect(rows).toEqual([{ cron: '* * * * *', timezone: 'UTC' }]);
    } finally {
      await jobs.end();
    }

    const { world, staging, people } = await running();
    await createAlert(world.operator, staging.id, [people.operator]);
    cpu.set(staging.id, '97');

    // The next minute's check finds it, which can take a minute.
    await waitUntil(() => expect(emailsTo(people.operator.email)).toHaveLength(1), { timeout: 100_000, interval: 1_000 });
  }, 120_000);
});
