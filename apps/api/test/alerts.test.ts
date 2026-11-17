import { createDomainEvent, isUuid, parseCompanyId } from '@dreamdevops/shared-kernel';
import { describe, expect, it } from 'vitest';
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
import { formatMetricValue } from '../src/monitoring/domain/metrics.ts';
import { type AlertEmail, AlertEmails } from '../src/notifications/application/alert-emails.ts';
import { NOTIFIABLE_EVENTS, summarize } from '../src/notifications/domain/event-catalog.ts';
import { COMPANY_A, FakeMailer } from './fakes.ts';

const OPS = '00000000-0000-4000-8000-0000000000d1';
const LEAD = '00000000-0000-4000-8000-0000000000d2';
const at = (minutes: number, seconds = 0) => new Date(Date.UTC(2026, 10, 10, 12, minutes, seconds));

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
      'Acme: The alert "High CPU" is firing: Billing API in the production environment "Production" has CPU above 80%, at 93%.',
    );
    expect(summarize(event('AlertResolved'), 'Acme')).toBe(
      'Acme: The alert "High CPU" is resolved: Billing API in the production environment "Production" no longer has CPU above 80%, at 93%.',
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
});
