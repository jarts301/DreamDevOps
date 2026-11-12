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
const emailsTo = (address: string) => mailer().sent.filter((email) => email.to === address);

/** Checks the company's alerts now, as the minute's scheduled check would. */
const checkNow = (world: World): Promise<CheckSummary> =>
  runWithCompany(parseCompanyId(world.companyId), () => harness.app.get(AlertChecks).check());

/** A company with an application that runs in Staging. */
const running = async () => {
  const world = await setUp();
  const image = await developmentImage(world);
  const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
  await deployed(world.developer, staging.id, { buildId: image.id });
  return { world, staging };
};

interface Alert {
  id: string;
  name: string;
  environmentId: string;
  environmentName: string | null;
  applicationName: string | null;
  condition: string;
  recipients: string[] | null;
  recipientCount: number;
  enabled: boolean;
  state: string;
  firingSince: string | null;
  lastValue: number | null;
  checkProblem: string | null;
  lastNotificationError: string | null;
}

const alertsOf = async (agent: Agent) => (await agent.get('/api/v1/company/alerts').expect(200)).body as { metricsEnabled: boolean; alerts: Alert[] };

const createAlert = async (agent: Agent, environmentId: string, overrides: object = {}) =>
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
        recipients: ['oncall@example.com'],
        ...overrides,
      })
      .expect(201)
  ).body as Alert;

describe('alerts', () => {
  it('watch an environment’s metric, and email when it fires and when it’s resolved', async () => {
    const { world, staging } = await running();
    const oncall = `oncall-${world.companyId}@example.com`;
    const lead = `lead-${world.companyId}@example.com`;
    const alert = await createAlert(world.operator, staging.id, { recipients: [oncall, ` ${lead.toUpperCase()} `] });

    expect(alert).toMatchObject({
      name: 'High CPU',
      environmentId: staging.id,
      environmentName: 'Staging',
      condition: 'CPU above 80%',
      recipients: [oncall, lead],
      enabled: true,
      state: 'ok',
    });

    cpu.set(staging.id, '92.5');
    expect(await checkNow(world)).toEqual({ checked: 1, triggered: 1, resolved: 0, problem: null });

    await eventually(() => {
      expect(emailsTo(oncall)).toHaveLength(1);
      expect(emailsTo(lead)).toHaveLength(1);
    });
    const [firing] = emailsTo(oncall);
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

    await eventually(() => expect(emailsTo(oncall)).toHaveLength(2));
    expect(emailsTo(oncall)[1]!.subject).toBe(`[Resolved] High CPU: ${alert.applicationName} in Staging`);
    expect(emailsTo(oncall)[1]!.text).toContain('Latest value: 10%');
    await eventually(async () => expect(emailsTo(lead)).toHaveLength(2));
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

  it('wait until the metric has stayed past the threshold for their minutes', async () => {
    const { world, staging } = await running();
    const address = `patient-${world.companyId}@example.com`;
    await createAlert(world.techLead, staging.id, { forMinutes: 5, recipients: [address] });
    cpu.set(staging.id, '95');

    expect(await checkNow(world)).toMatchObject({ triggered: 0 });

    expect((await alertsOf(world.viewer)).alerts[0]).toMatchObject({ state: 'pending', lastValue: 95 });
    expect(emailsTo(address)).toEqual([]);
  });

  it('show whom they email only to those who manage them, and let only them make changes', async () => {
    const { world, staging } = await running();
    const alert = await createAlert(world.operator, staging.id);

    expect((await alertsOf(world.viewer)).alerts[0]).toMatchObject({ recipients: null, recipientCount: 1 });
    expect((await alertsOf(world.admin)).alerts[0]!.recipients).toEqual(['oncall@example.com']);
    await world.developer.post('/api/v1/company/alerts').send({}).expect(403);
    await world.viewer.patch(`/api/v1/company/alerts/${alert.id}`).send({ enabled: false }).expect(403);
    await world.developer.delete(`/api/v1/company/alerts/${alert.id}`).expect(403);
  });

  it('stay within their company', async () => {
    const [{ world: ours, staging }, theirs] = await Promise.all([running(), setUp()]);
    const alert = await createAlert(ours.operator, staging.id);

    expect((await alertsOf(theirs.admin)).alerts).toEqual([]);
    await theirs.admin.patch(`/api/v1/company/alerts/${alert.id}`).send({ threshold: 90 }).expect(404);
    await theirs.admin.delete(`/api/v1/company/alerts/${alert.id}`).expect(404);
    await theirs.admin.post(`/api/v1/company/alerts/${alert.id}/test`).expect(404);
    const { body } = await theirs.admin
      .post('/api/v1/company/alerts')
      .send({ name: 'Theirs', environmentId: staging.id, metric: 'cpu', comparator: 'above', threshold: 1, forMinutes: 0, recipients: ['x@example.com'] })
      .expect(404);
    expect(body.detail).toBe('There’s no such environment.');
  });

  it('take a new threshold from the next check, and end their incident quietly when turned off', async () => {
    const { world, staging } = await running();
    const address = `quiet-${world.companyId}@example.com`;
    const alert = await createAlert(world.operator, staging.id, { recipients: [address] });
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
    const { world, staging } = await running();
    await createAlert(world.operator, staging.id, { recipients: [`down-${world.companyId}@example.com`] });
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
    const { world, staging } = await running();
    await createAlert(world.operator, staging.id);
    cpu.set(staging.id, '95');
    await checkNow(world);

    cpu.delete(staging.id);
    expect(await checkNow(world)).toMatchObject({ resolved: 1 });
    expect((await alertsOf(world.viewer)).alerts[0]).toMatchObject({ state: 'ok', lastValue: null });
  });

  it('have names of their own, and can be deleted with their history', async () => {
    const { world, staging } = await running();
    const alert = await createAlert(world.operator, staging.id);
    const { body } = await world.operator
      .post('/api/v1/company/alerts')
      .send({ name: 'high cpu', environmentId: staging.id, metric: 'memory', comparator: 'above', threshold: 1, forMinutes: 0, recipients: ['a@example.com'] })
      .expect(409);
    expect(body.detail).toBe('Another alert already has this name.');
    cpu.set(staging.id, '95');
    await checkNow(world);

    await world.operator.delete(`/api/v1/company/alerts/${alert.id}`).expect(204);

    expect((await alertsOf(world.viewer)).alerts).toEqual([]);
    expect((await world.viewer.get('/api/v1/company/alerts/incidents').expect(200)).body).toEqual([]);
    await eventually(async () => expect(await auditTypes(world.admin)).toContain('AlertDeleted'));
  });

  it('send a test email to every address, straight away', async () => {
    const { world, staging } = await running();
    const address = `test-${world.companyId}@example.com`;
    const alert = await createAlert(world.operator, staging.id, { recipients: [address] });

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
    const [{ world: watching, staging }, idle] = await Promise.all([running(), setUp()]);
    await createAlert(watching.operator, staging.id);

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

    const { world, staging } = await running();
    const address = `scheduled-${world.companyId}@example.com`;
    await createAlert(world.operator, staging.id, { recipients: [address] });
    cpu.set(staging.id, '97');

    // The next minute's check finds it, which can take a minute.
    await waitUntil(() => expect(emailsTo(address)).toHaveLength(1), { timeout: 100_000, interval: 1_000 });
  }, 120_000);
});
