import { createDomainEvent, isUuid, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { InMemoryJobQueue } from '@dreamdevops/shared-kernel/testing';
import { EventBus } from '@dreamdevops/shared-kernel';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AlertChecks, CheckSummary } from '../src/alerts/application/alert-checks.ts';
import { AlertDeliveries, EMAIL_QUEUE, type EmailJob } from '../src/alerts/application/alert-deliveries.ts';
import type { AlertRules } from '../src/alerts/application/alert-rules.ts';
import type { AlertTriggered } from '../src/alerts/domain/events.ts';
import type { CompanyDirectory } from '../src/tenancy/application/company-directory.ts';
import type { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import { jobIdFor } from '../src/alerts/application/job-ids.ts';
import {
  describeCondition,
  describeValue,
  isPastThreshold,
  parseAlertName,
  parseComparator,
  parseForMinutes,
  parseMetric,
  parseRecipientIds,
  parseThreshold,
} from '../src/alerts/domain/alert.ts';
import { AlertError } from '../src/alerts/domain/errors.ts';
import { type AlertStatus, nextStatus, OK } from '../src/alerts/domain/evaluation.ts';
import { AlertsSubscriptions, CHECK_QUEUE, CHECK_SCHEDULE, EVALUATE_QUEUE } from '../src/alerts/messaging/alerts-subscriptions.ts';
import { Entitlements } from '../src/editions/application/entitlements.ts';
import { COMPANY_MEMBERS, type CompanyMember } from '../src/identity-access/application/company-members.ts';
import { RUNNING_ENVIRONMENTS, type RunningEnvironment } from '../src/environments/application/running-environments.ts';
import { CompanyLatestMetrics } from '../src/monitoring/application/company-latest-metrics.ts';
import { MetricsUnavailableError } from '../src/monitoring/application/ports.ts';
import { formatMetricValue } from '../src/monitoring/domain/metrics.ts';
import { type AlertEmail, AlertEmails } from '../src/notifications/application/alert-emails.ts';
import { NOTIFIABLE_EVENTS, summarize } from '../src/notifications/domain/event-catalog.ts';
import { COMPANY_A, COMPANY_B, FakeCompanyMembers, FakeMailer, FakeMetricsStore, FakeRunningEnvironments } from './fakes.ts';
import { signIn as signInAs } from './support/integration.ts';
import { createTestApp, testConfig } from './test-app.ts';

const STAGING = '00000000-0000-4000-8000-0000000000e1';
const PRODUCTION = '00000000-0000-4000-8000-0000000000e2';
const THEIR_STAGING = '00000000-0000-4000-8000-0000000000f1';
const ALERT = '00000000-0000-4000-8000-0000000000c1';
const OPS = '00000000-0000-4000-8000-0000000000d1';
const LEAD = '00000000-0000-4000-8000-0000000000d2';
const FORMER = '00000000-0000-4000-8000-0000000000d3';
const THEIRS = '00000000-0000-4000-8000-0000000000d9';

const member = (userId: string, name: string, companyId = COMPANY_A): CompanyMember => ({
  userId,
  displayName: name,
  email: `${name.toLowerCase()}@${companyId === COMPANY_A ? 'a' : 'b'}.example.com`,
  role: 'operator',
});

/** Ops and Lead are members of company A, and someone else of company B. */
function members(): FakeCompanyMembers {
  const fake = new FakeCompanyMembers();
  fake.byCompany.set(COMPANY_A, [member(OPS, 'Ops'), member(LEAD, 'Lead')]);
  fake.byCompany.set(COMPANY_B, [member(THEIRS, 'Theirs', COMPANY_B)]);
  return fake;
}

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

  it('emails one to ten members, each once, by their user IDs', () => {
    expect(parseRecipientIds([OPS.toUpperCase(), OPS, LEAD])).toEqual([OPS, LEAD]);
    expect(() => parseRecipientIds([])).toThrow('Choose at least one member to email.');
    expect(() => parseRecipientIds(OPS)).toThrow('Choose at least one member to email.');
    // Addresses are no longer accepted: alerts email members, at their address as it is then.
    expect(() => parseRecipientIds(['ops@example.com'])).toThrow('Choose members of the company to email.');
    expect(() => parseRecipientIds(Array.from({ length: 11 }, (_, index) => `00000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`))).toThrow(
      'An alert emails at most 10 members.',
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
          'You get this email because the alert "High CPU" names you, as a member of Acme on DreamDevOps.',
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
    const rules = { forgetMember: async () => {} } as unknown as AlertRules;
    const subscriptions = new AlertsSubscriptions(checks, deliveries, rules, testConfig(), () => at(0, 30));

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

  it('take someone removed from the company off every alert, in that company', async () => {
    const queue = new InMemoryJobQueue();
    const bus = new EventBus(queue);
    const forgotten: { userId: string; companyId: string }[] = [];
    const { currentCompanyId } = await import('@dreamdevops/shared-kernel');
    const rules = {
      forgetMember: async (userId: string) => void forgotten.push({ userId, companyId: currentCompanyId() }),
    } as unknown as AlertRules;
    const idle = { companiesToCheck: async () => [], check: async () => ({}) } as unknown as AlertChecks;
    const deliveries = { deliver: async () => {}, fanOut: async () => {} } as unknown as AlertDeliveries;
    await new AlertsSubscriptions(idle, deliveries, rules, testConfig()).subscribe({ bus, queue });

    await bus.publish(
      createDomainEvent({
        eventType: 'MemberRemoved',
        companyId: parseCompanyId(COMPANY_A),
        payload: { userId: FORMER, role: 'operator', removedBy: OPS },
      }),
    );
    await queue.drain();

    expect(forgotten).toEqual([{ userId: FORMER, companyId: COMPANY_A }]);
  });
});

describe('alert emails go only to members', () => {
  /** A database whose alert names Ops, Lead and someone who has left since. */
  const database = (recipientIds: string[]) => {
    const queries: string[] = [];
    const fake = {
      transaction: async <T>(work: (tx: { query: (sql: string) => Promise<{ rows: object[] }> }) => Promise<T>) =>
        work({
          query: async (sql: string) => {
            queries.push(sql);
            return { rows: sql.includes('SELECT recipient_ids') ? [{ recipient_ids: recipientIds }] : [] };
          },
        }),
    } as unknown as TenantDatabase;
    return { fake, queries };
  };
  const companies = { find: async () => ({ id: COMPANY_A, name: 'Acme', slug: 'acme', status: 'active' }) } as unknown as CompanyDirectory;
  const event = (): AlertTriggered =>
    createDomainEvent({
      eventType: 'AlertTriggered',
      companyId: parseCompanyId(COMPANY_A),
      payload: {
        alertId: ALERT,
        name: 'High CPU',
        environmentId: STAGING,
        environmentName: 'Staging',
        applicationId: '00000000-0000-4000-8000-0000000000a1',
        applicationName: 'Billing API',
        production: false,
        metric: 'cpu',
        comparator: 'above',
        threshold: 80,
        forMinutes: 0,
        condition: 'CPU above 80%',
        incidentId: '00000000-0000-4000-8000-0000000000b7',
        measured: 93,
        value: '93%',
        firingSince: '2026-11-10T12:30:00.000Z',
      },
    }) as AlertTriggered;

  const setUp = () => {
    const mailer = new FakeMailer();
    const team = members();
    const { fake, queries } = database([OPS, LEAD, FORMER]);
    const deliveries = new AlertDeliveries(fake, companies, new AlertEmails(mailer, 'http://localhost:4200'), team);
    return { mailer, team, deliveries, queries };
  };

  it('queue one email per member the alert names, leaving out anyone no longer in the company', async () => {
    const { deliveries } = setUp();
    const queue = new InMemoryJobQueue();
    const jobs: EmailJob[] = [];
    await queue.createQueue(EMAIL_QUEUE);
    await queue.work(EMAIL_QUEUE, async (job) => void jobs.push(job.data as EmailJob));
    const triggered = event();

    await inCompany(COMPANY_A, () => deliveries.fanOut(triggered, queue));
    // Delivered twice, as events can be, it still queues each email once.
    await inCompany(COMPANY_A, () => deliveries.fanOut(triggered, queue));
    await queue.drain();

    expect(jobs.map((job) => job.userId)).toEqual([OPS, LEAD]);
  });

  it('send each to the member’s address as it is when sent', async () => {
    const { deliveries, mailer, team } = setUp();
    team.byCompany.set(COMPANY_A, [{ ...member(OPS, 'Ops'), email: 'ops.new@a.example.com' }, member(LEAD, 'Lead')]);

    await deliveries.deliver({ event: event(), userId: OPS });

    expect(mailer.sent.map((sent) => [sent.to, sent.subject])).toEqual([['ops.new@a.example.com', '[Firing] High CPU: Billing API in Staging']]);
  });

  it('never email someone removed from the company after the alert fired', async () => {
    const { deliveries, mailer, team, queries } = setUp();
    team.remove(COMPANY_A, LEAD);

    await deliveries.deliver({ event: event(), userId: LEAD });
    // Nor anyone of another company, whatever a job says.
    await deliveries.deliver({ event: event(), userId: THEIRS });

    expect(mailer.sent).toEqual([]);
    expect(queries).toEqual([]);
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
        { provide: COMPANY_MEMBERS, useValue: members() },
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
  const valid = { name: 'High CPU', environmentId: STAGING, metric: 'cpu', comparator: 'above', threshold: 80, forMinutes: 5, recipients: [OPS] };

  it.each([
    ['GET', '/api/v1/company/alerts'],
    ['GET', '/api/v1/company/alerts/incidents'],
    ['GET', '/api/v1/company/alerts/members'],
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
    expect((await post({ ...valid, recipients: [] }).expect(400)).body.detail).toBe('Choose at least one member to email.');
    expect((await post({ ...valid, recipients: ['ops@example.com'] }).expect(400)).body.detail).toBe(
      'Choose members of the company to email.',
    );
    expect((await post({ ...valid, environmentId: 'staging' }).expect(400)).body.detail).toBe('Choose the environment to watch.');
  });

  it('email only members of the company: not someone who left, nor another company’s', async () => {
    const operator = await signIn('operator-a');
    const post = (recipients: string[]) =>
      operator.post('/api/v1/company/alerts').set('Origin', 'http://dashboard.test').send({ ...valid, recipients });

    for (const recipients of [[OPS, FORMER], [THEIRS]]) {
      expect((await post(recipients).expect(400)).body.detail).toBe(
        'Choose members of the company to email. Someone chosen isn’t a member.',
      );
    }
    await operator
      .patch(`/api/v1/company/alerts/${ALERT}`)
      .set('Origin', 'http://dashboard.test')
      .send({ recipients: [FORMER] })
      .expect(400);
  });

  it('offer those who manage alerts the company’s members to email, and nobody else', async () => {
    const { body } = await (await signIn('operator-a')).get('/api/v1/company/alerts/members').expect(200);

    expect(body).toEqual([
      { userId: OPS, displayName: 'Ops', email: 'ops@a.example.com' },
      { userId: LEAD, displayName: 'Lead', email: 'lead@a.example.com' },
    ]);
    await (await signIn('viewer-a')).get('/api/v1/company/alerts/members').expect(403);
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
