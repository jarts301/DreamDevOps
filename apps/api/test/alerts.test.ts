import { createDomainEvent, isUuid, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { InMemoryJobQueue } from '@dreamdevops/shared-kernel/testing';
import { EventBus } from '@dreamdevops/shared-kernel';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AlertChecks, CheckSummary } from '../src/alerts/application/alert-checks.ts';
import type { AlertDeliveries, EmailJob } from '../src/alerts/application/alert-deliveries.ts';
import { jobIdFor } from '../src/alerts/application/job-ids.ts';
import {
  describeCondition,
  describeValue,
  isPastThreshold,
  parseAlertName,
  parseComparator,
  parseForMinutes,
  parseMetric,
  parseRecipients,
  parseThreshold,
} from '../src/alerts/domain/alert.ts';
import { AlertError } from '../src/alerts/domain/errors.ts';
import { type AlertStatus, nextStatus, OK } from '../src/alerts/domain/evaluation.ts';
import { AlertsSubscriptions, CHECK_QUEUE, CHECK_SCHEDULE, EVALUATE_QUEUE } from '../src/alerts/messaging/alerts-subscriptions.ts';
import { Entitlements } from '../src/editions/application/entitlements.ts';
import { RUNNING_ENVIRONMENTS, type RunningEnvironment } from '../src/environments/application/running-environments.ts';
import { CompanyLatestMetrics } from '../src/monitoring/application/company-latest-metrics.ts';
import { MetricsUnavailableError } from '../src/monitoring/application/ports.ts';
import { formatMetricValue } from '../src/monitoring/domain/metrics.ts';
import { type AlertEmail, AlertEmails } from '../src/notifications/application/alert-emails.ts';
import { NOTIFIABLE_EVENTS, summarize } from '../src/notifications/domain/event-catalog.ts';
import { COMPANY_A, COMPANY_B, FakeMailer, FakeMetricsStore, FakeRunningEnvironments } from './fakes.ts';
import { signIn as signInAs } from './support/integration.ts';
import { createTestApp, testConfig } from './test-app.ts';

const STAGING = '00000000-0000-4000-8000-0000000000e1';
const PRODUCTION = '00000000-0000-4000-8000-0000000000e2';
const THEIR_STAGING = '00000000-0000-4000-8000-0000000000f1';
const ALERT = '00000000-0000-4000-8000-0000000000c1';

const MINUTE = 60_000;
const at = (minutes: number, seconds = 0) => new Date(Date.UTC(2026, 10, 10, 12, minutes, seconds));

const inCompany = <T>(companyId: string, work: () => Promise<T>) => runWithCompany(parseCompanyId(companyId), work);

const running = (overrides: Partial<RunningEnvironment>): RunningEnvironment => ({
  environmentId: STAGING,
  environmentName: 'Staging',
  applicationId: '00000000-0000-4000-8000-0000000000a1',
  production: false,
  version: '1.4.0',
  since: '2026-11-10T09:00:00.000Z',
  address: null,
  targetName: 'This machine',
  limits: null,
  ...overrides,
});

describe('what an alert may say', () => {
  it('takes a name of 2 to 80 characters, tidied up', () => {
    expect(parseAlertName('  High   CPU ')).toBe('High CPU');
    for (const name of ['x', 'y'.repeat(81), 42, undefined, 'Bell\u0007']) {
      expect(() => parseAlertName(name)).toThrow(AlertError);
    }
  });

  it('watches one of the metrics Monitoring shows, above or below a threshold', () => {
    expect(['cpu', 'memory', 'requests', 'responseTime', 'errors'].map(parseMetric)).toHaveLength(5);
    expect(() => parseMetric('disk')).toThrow('Choose a metric: cpu, memory, requests, responseTime, errors.');
    expect(() => parseMetric('toString')).toThrow(AlertError);
    expect(parseComparator('above')).toBe('above');
    expect(parseComparator('below')).toBe('below');
    expect(() => parseComparator('equals')).toThrow(AlertError);
  });

  it('takes a threshold of zero or more, in the metric’s own unit, and at most 100% of server errors', () => {
    expect(parseThreshold(0, 'cpu')).toBe(0);
    // Several cores can take CPU past 100%.
    expect(parseThreshold(250, 'cpu')).toBe(250);
    expect(parseThreshold(512 * 1024 * 1024, 'memory')).toBe(536_870_912);
    expect(parseThreshold(100, 'errors')).toBe(100);
    expect(() => parseThreshold(100.5, 'errors')).toThrow('at most 100%');
    for (const threshold of [-1, Number.NaN, Number.POSITIVE_INFINITY, '80', null, 1e15]) {
      expect(() => parseThreshold(threshold, 'cpu')).toThrow('Enter a threshold of zero or more.');
    }
  });

  it('waits a whole number of minutes, up to an hour, before firing', () => {
    expect(parseForMinutes(0)).toBe(0);
    expect(parseForMinutes(60)).toBe(60);
    for (const minutes of [-1, 61, 1.5, '5', null]) {
      expect(() => parseForMinutes(minutes)).toThrow(AlertError);
    }
  });

  it('emails one to ten addresses, each once, in lowercase', () => {
    expect(parseRecipients([' Ops@Example.com ', 'ops@example.com', 'lead@example.com'])).toEqual([
      'ops@example.com',
      'lead@example.com',
    ]);
    expect(() => parseRecipients([])).toThrow('Enter at least one email address to notify.');
    expect(() => parseRecipients('ops@example.com')).toThrow(AlertError);
    expect(() => parseRecipients(['ops@example.com', 'not an address'])).toThrow('"not an address" isn\'t a valid email address.');
    expect(() => parseRecipients(Array.from({ length: 11 }, (_, index) => `person${index}@example.com`))).toThrow(
      'An alert emails at most 10 addresses.',
    );
  });

  it('is past its threshold only with a value beyond it, and never without one', () => {
    expect(isPastThreshold(81, { comparator: 'above', threshold: 80 })).toBe(true);
    expect(isPastThreshold(80, { comparator: 'above', threshold: 80 })).toBe(false);
    expect(isPastThreshold(0.5, { comparator: 'below', threshold: 1 })).toBe(true);
    expect(isPastThreshold(1, { comparator: 'below', threshold: 1 })).toBe(false);
    expect(isPastThreshold(null, { comparator: 'above', threshold: 0 })).toBe(false);
    expect(isPastThreshold(null, { comparator: 'below', threshold: 100 })).toBe(false);
  });

  it('reads as people read the Monitoring page, with its units', () => {
    expect(describeCondition({ metric: 'cpu', comparator: 'above', threshold: 80, forMinutes: 5 }, { withDuration: true })).toBe(
      'CPU above 80% for 5 minutes',
    );
    expect(describeCondition({ metric: 'cpu', comparator: 'above', threshold: 80, forMinutes: 1 }, { withDuration: true })).toBe(
      'CPU above 80% for 1 minute',
    );
    expect(describeCondition({ metric: 'cpu', comparator: 'above', threshold: 80, forMinutes: 5 }, { withDuration: false })).toBe(
      'CPU above 80%',
    );
    expect(
      describeCondition({ metric: 'memory', comparator: 'above', threshold: 450 * 1024 * 1024, forMinutes: 0 }, { withDuration: true }),
    ).toBe('Memory above 450.0 MiB');
    expect(describeCondition({ metric: 'responseTime', comparator: 'above', threshold: 0.5, forMinutes: 0 }, { withDuration: true })).toBe(
      'Response time above 500 ms',
    );
    expect(describeCondition({ metric: 'requests', comparator: 'below', threshold: 1, forMinutes: 10 }, { withDuration: true })).toBe(
      'Requests below 1.0/s for 10 minutes',
    );
    expect(describeValue(92.5, 'cpu')).toBe('93%');
    expect(describeValue(null, 'errors')).toBe('No data');
    expect(formatMetricValue(2 * 1024 * 1024 * 1024, 'bytes')).toBe('2.00 GiB');
    expect(formatMetricValue(1.5, 'seconds')).toBe('1.50 s');
  });
});

describe('checking an alert', () => {
  const pending = (since: Date): AlertStatus => ({ state: 'pending', pendingSince: since });
  const firing: AlertStatus = { state: 'firing', pendingSince: null };

  it('fires at once when it waits no minutes', () => {
    expect(nextStatus(OK, true, 0, at(0))).toEqual({ status: firing, transition: 'triggered' });
  });

  it('waits while the metric stays past the threshold, and fires once it has for its minutes', () => {
    let current = nextStatus(OK, true, 5, at(0));
    expect(current).toEqual({ status: pending(at(0)), transition: null });
    for (const minute of [1, 2, 3, 4]) {
      current = nextStatus(current.status, true, 5, at(minute));
      expect(current).toEqual({ status: pending(at(0)), transition: null });
    }
    expect(nextStatus(current.status, true, 5, at(5))).toEqual({ status: firing, transition: 'triggered' });
  });

  it('counts a check a few seconds early as a minute passed, as checks run about once a minute', () => {
    expect(nextStatus(pending(at(0, 0)), true, 1, at(0, 55)).transition).toBe('triggered');
    expect(nextStatus(pending(at(0, 0)), true, 1, at(0, 45)).transition).toBeNull();
  });

  it('starts waiting afresh when the metric comes back before its time', () => {
    const back = nextStatus(pending(at(0)), false, 5, at(3));
    expect(back).toEqual({ status: OK, transition: null });
    expect(nextStatus(back.status, true, 5, at(4))).toEqual({ status: pending(at(4)), transition: null });
  });

  it('keeps firing, without telling anyone again, and is resolved when the metric is back', () => {
    expect(nextStatus(firing, true, 5, at(10))).toEqual({ status: firing, transition: null });
    expect(nextStatus(firing, false, 5, at(11))).toEqual({ status: OK, transition: 'resolved' });
    expect(nextStatus(OK, false, 5, at(12))).toEqual({ status: OK, transition: null });
  });
});

describe('the latest metrics Monitoring offers other contexts', () => {
  const world = () => {
    const environments = new FakeRunningEnvironments();
    environments.byCompany.set(COMPANY_A, [
      running({}),
      running({ environmentId: PRODUCTION, environmentName: 'Production', production: true }),
      running({ environmentId: '00000000-0000-4000-8000-0000000000e9', version: null }),
    ]);
    environments.byCompany.set(COMPANY_B, [running({ environmentId: THEIR_STAGING })]);
    const store = new FakeMetricsStore();
    store.latestValues.set(STAGING, { cpu: 92, memory: 1, requests: 2, responseTime: 0.1, errors: 0 });
    store.latestValues.set(THEIR_STAGING, { cpu: 5, memory: 1, requests: 2, responseTime: 0.1, errors: 0 });
    return { environments, store };
  };

  it('answers for the company’s running environments only, and never asks the store about another company’s', async () => {
    const { environments, store } = world();
    const metrics = new CompanyLatestMetrics(environments, store);

    const answer = await inCompany(COMPANY_A, () => metrics.of([STAGING, PRODUCTION, THEIR_STAGING]));

    expect(answer.status).toBe('ok');
    expect(answer.status === 'ok' && [...answer.values.keys()]).toEqual([STAGING]);
    expect(store.asked).toEqual([[STAGING, PRODUCTION]]);
    expect(metrics.enabled).toBe(true);
  });

  it('asks nothing when it’s asked about nothing, or about nothing of the company’s', async () => {
    const { environments, store } = world();
    const metrics = new CompanyLatestMetrics(environments, store);

    expect(await inCompany(COMPANY_A, () => metrics.of([]))).toEqual({ status: 'ok', values: new Map() });
    expect(await inCompany(COMPANY_A, () => metrics.of([THEIR_STAGING]))).toEqual({ status: 'ok', values: new Map() });
    expect(store.asked).toEqual([]);
  });

  it('says when the server keeps no metrics, or the store can’t answer', async () => {
    const { environments, store } = world();
    const without = new CompanyLatestMetrics(environments, null);
    expect(without.enabled).toBe(false);
    expect(await inCompany(COMPANY_A, () => without.of([STAGING]))).toEqual({ status: 'not-set-up' });

    store.failure = new MetricsUnavailableError('The metrics store can’t be reached right now. Try again shortly.');
    expect(await inCompany(COMPANY_A, () => new CompanyLatestMetrics(environments, store).of([STAGING]))).toEqual({
      status: 'unavailable',
      problem: 'The metrics store can’t be reached right now. Try again shortly.',
    });
  });
});

describe('alert emails', () => {
  const email = (overrides: Partial<AlertEmail> = {}): AlertEmail => ({
    kind: 'firing',
    to: 'oncall@example.com',
    companyName: 'Acme',
    alertName: 'High CPU',
    applicationName: 'Billing API',
    environmentName: 'Production',
    production: true,
    condition: 'CPU above 80% for 5 minutes',
    value: '93%',
    firingSince: '2026-11-10T12:30:00.000Z',
    at: '2026-11-10T12:30:00.000Z',
    ...overrides,
  });

  it('say an alert fires, what it watches, its value, and link to the dashboard', async () => {
    const mailer = new FakeMailer();

    await new AlertEmails(mailer, 'http://localhost:4200/').send(email());

    expect(mailer.sent).toEqual([
      {
        to: 'oncall@example.com',
        subject: '[Firing] High CPU: Billing API in Production',
        text: [
          'Acme: the alert "High CPU" is firing.',
          '',
          'It watches Billing API in the production environment "Production" for CPU above 80% for 5 minutes.',
          'Latest value: 93%',
          'Firing since: Tue, 10 Nov 2026 12:30 UTC',
          '',
          'See your alerts on the dashboard:',
          'http://localhost:4200/alerts',
          '',
          'You get this email because the alert "High CPU" in Acme on DreamDevOps names this address.',
        ].join('\n'),
      },
    ]);
  });

  it('say when it’s resolved, and how long it fired', async () => {
    const mailer = new FakeMailer();

    await new AlertEmails(mailer, 'http://localhost:4200').send(
      email({ kind: 'resolved', production: false, environmentName: 'Staging', value: '12%', at: '2026-11-10T14:42:00.000Z' }),
    );

    expect(mailer.sent[0]!.subject).toBe('[Resolved] High CPU: Billing API in Staging');
    expect(mailer.sent[0]!.text).toContain('It watches Billing API in the environment "Staging" for CPU above 80% for 5 minutes, which no longer holds.');
    expect(mailer.sent[0]!.text).toContain('Latest value: 12%');
    expect(mailer.sent[0]!.text).toContain(
      'It fired from Tue, 10 Nov 2026 12:30 UTC to Tue, 10 Nov 2026 14:42 UTC, for 2 hours 12 minutes.',
    );
  });

  it('say a test is only a test', async () => {
    const mailer = new FakeMailer();

    await new AlertEmails(mailer, 'http://localhost:4200').send(email({ kind: 'test', firingSince: null }));

    expect(mailer.sent[0]!.subject).toBe('[Test] High CPU: Billing API in Production');
    expect(mailer.sent[0]!.text).toContain('Nothing is wrong');
  });

  it('throw when the mail server fails, so the job tries again', async () => {
    const mailer = new FakeMailer();
    mailer.failing = true;

    await expect(new AlertEmails(mailer, 'http://localhost:4200').send(email())).rejects.toThrow('Mail server unavailable');
  });

  it('can also be posted to chat, as events anyone can choose', () => {
    const payload = {
      name: 'High CPU',
      environmentName: 'Production',
      applicationName: 'Billing API',
      production: true,
      condition: 'CPU above 80%',
      value: '93%',
    };
    const event = (eventType: string) => createDomainEvent({ eventType, companyId: parseCompanyId(COMPANY_A), payload });

    expect(Object.keys(NOTIFIABLE_EVENTS)).toEqual(expect.arrayContaining(['AlertTriggered', 'AlertResolved']));
    expect(summarize(event('AlertTriggered'), 'Acme')).toBe(
      'Acme: The alert "High CPU" is firing: the production environment "Production" of "Billing API" has CPU above 80%, at 93%.',
    );
    expect(summarize(event('AlertResolved'), 'Acme')).toBe(
      'Acme: The alert "High CPU" is resolved: the production environment "Production" of "Billing API" no longer has CPU above 80%, at 93%.',
    );
  });
});

describe('alert jobs', () => {
  it('have IDs made from what they’re about, so each is queued once', () => {
    const id = jobIdFor('alert-email', 'event-1', 'ops@example.com');

    expect(isUuid(id)).toBe(true);
    expect(jobIdFor('alert-email', 'event-1', 'ops@example.com')).toBe(id);
    expect(jobIdFor('alert-email', 'event-1', 'lead@example.com')).not.toBe(id);
  });

  it('check every company with alerts every minute, once a minute, each in its own company', async () => {
    const queue = new InMemoryJobQueue();
    const checked: string[] = [];
    const checks = {
      companiesToCheck: async () => [COMPANY_A, COMPANY_B],
      check: async (): Promise<CheckSummary> => {
        const { currentCompanyId } = await import('@dreamdevops/shared-kernel');
        checked.push(currentCompanyId());
        return { checked: 1, triggered: 0, resolved: 0, problem: null };
      },
    } as unknown as AlertChecks;
    const delivered: EmailJob[] = [];
    const deliveries = { deliver: async (job: EmailJob) => void delivered.push(job), fanOut: async () => {} } as unknown as AlertDeliveries;
    const subscriptions = new AlertsSubscriptions(checks, deliveries, testConfig(), () => at(0, 30));

    await subscriptions.subscribe({ bus: new EventBus(queue), queue });

    expect(queue.schedulesOf().get(CHECK_QUEUE)).toEqual({ cron: CHECK_SCHEDULE, data: {} });
    expect(CHECK_SCHEDULE).toBe('* * * * *');
    await queue.runSchedules();
    expect(checked).toEqual([COMPANY_A, COMPANY_B]);

    // Asked again in the same minute, such as by a second API process, nobody is checked twice.
    await queue.runSchedules();
    expect(checked).toEqual([COMPANY_A, COMPANY_B]);
    await queue.send(EVALUATE_QUEUE, { companyId: COMPANY_A }, { id: jobIdFor('alerts-check', COMPANY_A, String(Math.floor(at(0, 30).getTime() / MINUTE))) });
    await queue.drain();
    expect(checked).toHaveLength(2);
  });
});

describe('alert routes', () => {
  let app: INestApplication;
  let entitled = true;
  const environments = new FakeRunningEnvironments();
  environments.byCompany.set(COMPANY_A, [running({})]);

  beforeAll(async () => {
    app = await createTestApp({
      config: { secureCookies: false },
      overrides: [
        { provide: RUNNING_ENVIRONMENTS, useValue: environments },
        { provide: Entitlements, useValue: { isEnabled: async () => entitled } },
      ],
    });
  });

  afterEach(() => {
    entitled = true;
  });

  afterAll(async () => {
    await app.close();
  });

  const signIn = (user: string) => signInAs(app, user);
  const valid = { name: 'High CPU', environmentId: STAGING, metric: 'cpu', comparator: 'above', threshold: 80, forMinutes: 5, recipients: ['ops@example.com'] };

  it.each([
    ['GET', '/api/v1/company/alerts'],
    ['GET', '/api/v1/company/alerts/incidents'],
    ['POST', '/api/v1/company/alerts'],
    ['PATCH', `/api/v1/company/alerts/${ALERT}`],
    ['DELETE', `/api/v1/company/alerts/${ALERT}`],
    ['POST', `/api/v1/company/alerts/${ALERT}/test`],
  ])('ask anonymous users to sign in: %s %s', async (method, path) => {
    await request(app.getHttpServer())[method.toLowerCase() as 'get'](path).set('Origin', 'http://dashboard.test').expect(401);
  });

  it('refuse members who don’t view dashboards, and people with no company', async () => {
    await (await signIn('developer-a')).get('/api/v1/company/alerts').expect(403);
    await (await signIn('platform-admin')).get('/api/v1/company/alerts/incidents').expect(403);
  });

  it('let only those who manage alerts change them', async () => {
    const viewer = await signIn('viewer-a');

    await viewer.post('/api/v1/company/alerts').set('Origin', 'http://dashboard.test').send(valid).expect(403);
    await viewer.patch(`/api/v1/company/alerts/${ALERT}`).set('Origin', 'http://dashboard.test').send({ enabled: false }).expect(403);
    await viewer.delete(`/api/v1/company/alerts/${ALERT}`).set('Origin', 'http://dashboard.test').expect(403);
    await viewer.post(`/api/v1/company/alerts/${ALERT}/test`).set('Origin', 'http://dashboard.test').expect(403);
  });

  it('say what’s wrong with an alert before saving anything', async () => {
    const operator = await signIn('operator-a');
    const post = (body: object) => operator.post('/api/v1/company/alerts').set('Origin', 'http://dashboard.test').send(body);

    expect((await post({ ...valid, name: 'x' }).expect(400)).body.detail).toBe('Enter an alert name between 2 and 80 characters.');
    expect((await post({ ...valid, metric: 'disk' }).expect(400)).body.detail).toMatch(/^Choose a metric/);
    expect((await post({ ...valid, threshold: -5 }).expect(400)).body.detail).toBe('Enter a threshold of zero or more.');
    expect((await post({ ...valid, recipients: [] }).expect(400)).body.detail).toBe('Enter at least one email address to notify.');
    expect((await post({ ...valid, environmentId: 'staging' }).expect(400)).body.detail).toBe('Choose the environment to watch.');
  });

  it('refuse to watch an environment the company doesn’t have', async () => {
    const operator = await signIn('operator-a');

    const { body } = await operator
      .post('/api/v1/company/alerts')
      .set('Origin', 'http://dashboard.test')
      .send({ ...valid, environmentId: THEIR_STAGING })
      .expect(404);

    expect(body.detail).toBe('There’s no such environment.');
  });

  it('never let what an alert watches change', async () => {
    const operator = await signIn('operator-a');

    const { body } = await operator
      .patch(`/api/v1/company/alerts/${ALERT}`)
      .set('Origin', 'http://dashboard.test')
      .send({ metric: 'memory' })
      .expect(400);

    expect(body.detail).toBe('What an alert watches can’t change. Create another alert instead.');
  });

  it('refuse companies whose edition lacks monitoring', async () => {
    entitled = false;

    const { body } = await (await signIn('viewer-a')).get('/api/v1/company/alerts').expect(403);

    expect(body.detail).toBe("Your company's edition doesn't include this feature.");
  });
});
