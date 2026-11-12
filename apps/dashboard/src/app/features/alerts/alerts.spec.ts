import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { describeEvent } from '../../core/events';
import { permissionDescription } from '../../core/labels';
import { SessionService } from '../../core/session.service';
import { settle } from '../../testing';
import type { MetricDefinition } from '../monitoring/monitoring.api';
import { fromThreshold, inputUnit, toThreshold } from './alert-units';
import { Alerts } from './alerts';
import type { Alert, AlertsOverview, Incident, Recipient } from './alerts.api';

const METRICS: MetricDefinition[] = [
  { key: 'cpu', name: 'CPU', unit: 'percent', description: 'How much of one CPU core it uses.' },
  { key: 'memory', name: 'Memory', unit: 'bytes', description: 'How much memory it holds.' },
  { key: 'requests', name: 'Requests', unit: 'per-second', description: 'HTTP requests it answers each second.' },
  { key: 'responseTime', name: 'Response time', unit: 'seconds', description: 'The time within which it answers 95% of requests.' },
  { key: 'errors', name: 'Server errors', unit: 'percent', description: 'The share of requests it answers with a 5xx error.' },
];

const MIB = 1024 * 1024;

const ME: Recipient = { userId: 'u-me', displayName: 'Me Myself', email: 'me@example.com' };
const ONCALL: Recipient = { userId: 'u-oncall', displayName: 'On Call', email: 'oncall@example.com' };
const LEAD: Recipient = { userId: 'u-lead', displayName: 'Lead', email: 'lead@example.com' };
const MEMBERS = [LEAD, ME, ONCALL];

const alert = (overrides: Partial<Alert> = {}): Alert => ({
  id: 'al-1',
  name: 'High CPU',
  environmentId: 'e-2',
  environmentName: 'Production',
  applicationId: 'a-1',
  applicationName: 'Billing API',
  production: true,
  metric: 'cpu',
  comparator: 'above',
  threshold: 80,
  forMinutes: 5,
  condition: 'CPU above 80% for 5 minutes',
  recipients: [ONCALL, LEAD],
  recipientCount: 2,
  enabled: true,
  state: 'firing',
  pendingSince: null,
  firingSince: '2026-11-10T12:30:00Z',
  lastValue: 92.5,
  lastCheckedAt: '2026-11-10T12:34:00Z',
  checkProblem: null,
  lastNotifiedAt: '2026-11-10T12:30:05Z',
  lastNotificationError: null,
  createdAt: '2026-11-10T09:00:00Z',
  ...overrides,
});

const overview = (overrides: Partial<AlertsOverview> = {}): AlertsOverview => ({
  metricsEnabled: true,
  metrics: METRICS,
  alerts: [
    alert(),
    alert({
      id: 'al-2',
      name: 'Slow answers',
      environmentId: 'e-1',
      environmentName: 'Staging',
      production: false,
      metric: 'responseTime',
      threshold: 0.5,
      forMinutes: 0,
      condition: 'Response time above 500 ms',
      state: 'ok',
      firingSince: null,
      lastValue: 0.084,
      lastNotificationError: 'Mail server unavailable',
    }),
  ],
  ...overrides,
});

const INCIDENTS: Incident[] = [
  {
    id: 'i-2',
    alertId: 'al-1',
    alertName: 'High CPU',
    environmentName: 'Production',
    applicationName: 'Billing API',
    production: true,
    condition: 'CPU above 80% for 5 minutes',
    startedAt: '2026-11-10T12:30:00Z',
    startValue: '93%',
    resolvedAt: null,
    endValue: null,
    endedBy: null,
  },
  {
    id: 'i-1',
    alertId: 'al-1',
    alertName: 'High CPU',
    environmentName: 'Production',
    applicationName: 'Billing API',
    production: true,
    condition: 'CPU above 80% for 5 minutes',
    startedAt: '2026-11-09T08:00:00Z',
    startValue: '88%',
    resolvedAt: '2026-11-09T08:20:00Z',
    endValue: '12%',
    endedBy: 'recovered',
  },
];

const MANAGER = ['dashboards:view', 'alerts:manage'];

describe('alerts', () => {
  let http: HttpTestingController;

  const setUp = (permissions: string[], query: Record<string, string> = {}) => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: SessionService,
          useValue: {
            user: () => ({ permissions, userId: ME.userId, email: ME.email }),
            can: (permission: string) => permissions.includes(permission),
          },
        },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  };

  afterEach(() => http.verify());

  const element = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
  const text = (fixture: ComponentFixture<unknown>) => (element(fixture).textContent ?? '').replace(/\s+/g, ' ');
  const button = (fixture: ComponentFixture<unknown>, label: string) =>
    [...element(fixture).querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
    );
  const render = async (fixture: ComponentFixture<unknown>) => {
    await settle();
    await fixture.whenStable();
  };
  const field = <T extends HTMLElement = HTMLInputElement>(scope: Element, label: string) =>
    [...scope.querySelectorAll('label')]
      .find((candidate) => candidate.querySelector('span')?.textContent?.trim().startsWith(label))!
      .querySelector<T & HTMLElement>('input, select')!;
  const type = async (fixture: ComponentFixture<unknown>, input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render(fixture);
  };
  const choose = async (fixture: ComponentFixture<unknown>, select: HTMLSelectElement, index: number) => {
    select.selectedIndex = index;
    select.dispatchEvent(new Event('change'));
    await render(fixture);
  };
  const answerReload = (page = overview(), incidents = INCIDENTS) => {
    http.expectOne('/api/v1/company/alerts').flush(page);
    http.expectOne('/api/v1/company/alerts/incidents').flush(incidents);
  };

  const open = async (
    permissions: string[],
    options: {
      page?: AlertsOverview;
      incidents?: Incident[];
      query?: Record<string, string>;
      environments?: object[];
      members?: Recipient[];
    } = {},
  ) => {
    setUp(permissions, options.query);
    const fixture = TestBed.createComponent(Alerts);
    fixture.detectChanges();
    await settle();
    answerReload(options.page, options.incidents);
    if (permissions.includes('alerts:manage')) {
      http.expectOne('/api/v1/company/alerts/members').flush(options.members ?? MEMBERS);
      http.expectOne((request) => request.url === '/api/v1/company/applications').flush([{ id: 'a-1', name: 'Billing API' }]);
      await settle();
      http
        .expectOne((request) => request.url === '/api/v1/company/applications/a-1/environments')
        .flush(
          options.environments ?? [
            { id: 'e-2', name: 'Production', production: true },
            { id: 'e-1', name: 'Staging', production: false },
          ],
        );
    }
    await render(fixture);
    return fixture;
  };

  it('shows each alert, what it watches, how it is, and its latest value', async () => {
    const fixture = await open(MANAGER);

    const rows = element(fixture).querySelectorAll('tbody tr');
    expect(rows[0]!.getAttribute('data-state')).toBe('firing');
    expect(rows[0]!.textContent).toContain('Billing API · Production');
    expect(rows[0]!.querySelector('[data-tone="danger"]')?.textContent).toBe('Firing');
    expect(rows[0]!.textContent).toContain('CPU above 80% for 5 minutes');
    expect(rows[0]!.textContent).toContain('93%');
    expect(rows[0]!.textContent).toContain('On Call, Lead');
    expect(rows[1]!.querySelector('[data-tone="success"]')?.textContent).toBe('OK');
    expect(rows[1]!.textContent).toContain('84 ms');
    expect(text(fixture)).toContain('Email failed: Mail server unavailable');
  });

  it('lets members who can’t manage alerts look, without whom they email or any change', async () => {
    const fixture = await open(['dashboards:view'], {
      page: overview({ alerts: [alert({ recipients: null, recipientCount: 2 })] }),
    });

    expect(text(fixture)).toContain('2 members');
    expect(text(fixture)).not.toContain('New alert');
    expect(button(fixture, 'Edit High CPU')).toBeUndefined();
    expect(button(fixture, 'Delete High CPU')).toBeUndefined();
  });

  it('creates an alert on the environment Monitoring linked to, with memory typed in MiB, emailing chosen members', async () => {
    const fixture = await open(MANAGER, { query: { environment: 'e-1' }, page: overview({ alerts: [] }) });
    const form = element(fixture).querySelector('form')!;
    const box = (member: Recipient) =>
      [...form.querySelectorAll('label.checkbox')].find((label) => label.textContent?.includes(member.email))!.querySelector('input')!;

    expect(field<HTMLSelectElement>(form, 'Environment').value).toBe('e-1');
    // Only the company's members can be chosen, and whoever creates it is chosen at first.
    expect([...form.querySelectorAll('label.checkbox')].map((label) => label.textContent?.trim())).toEqual([
      'Lead (lead@example.com)',
      'Me Myself (me@example.com), you',
      'On Call (oncall@example.com)',
    ]);
    expect([LEAD, ME, ONCALL].map((member) => box(member).checked)).toEqual([false, true, false]);
    await type(fixture, field(form, 'Name'), 'Memory filling up');
    await choose(fixture, field<HTMLSelectElement>(form, 'Metric'), 1);
    expect(text(fixture)).toContain('Threshold (MiB)');
    await type(fixture, field(form, 'Threshold'), '450');
    await choose(fixture, field<HTMLSelectElement>(form, 'How long'), 4);
    box(ONCALL).click();
    await render(fixture);

    button(fixture, 'Create alert')!.click();
    const request = http.expectOne((candidate) => candidate.method === 'POST');
    expect(request.request.body).toEqual({
      name: 'Memory filling up',
      environmentId: 'e-1',
      metric: 'memory',
      comparator: 'above',
      threshold: 450 * MIB,
      forMinutes: 10,
      recipients: [ME.userId, ONCALL.userId],
    });
    request.flush(alert({ name: 'Memory filling up' }));
    await settle();
    answerReload();
    await render(fixture);

    expect(text(fixture)).toContain('The alert "Memory filling up" is created.');
  });

  it('says when there’s nothing to watch yet, or the server keeps no metrics', async () => {
    const fixture = await open(MANAGER, { environments: [], page: overview({ metricsEnabled: false, alerts: [] }) });

    expect(text(fixture)).toContain("There's no environment to watch yet.");
    expect(text(fixture)).toContain("This server doesn't keep applications' metrics yet");
    expect(text(fixture)).toContain('No alerts yet.');
  });

  it('changes an alert’s threshold, in the unit people read it in', async () => {
    const fixture = await open(MANAGER);

    button(fixture, 'Edit Slow answers')!.click();
    await render(fixture);
    const form = element(fixture).querySelector('td[colspan] form')!;
    expect(field(form, 'Threshold').value).toBe('500');
    await type(fixture, field(form, 'Threshold'), '750');
    button(fixture, 'Save')!.click();

    const request = http.expectOne((candidate) => candidate.method === 'PATCH');
    expect(request.request.url).toBe('/api/v1/company/alerts/al-2');
    expect(request.request.body).toEqual({
      name: 'Slow answers',
      threshold: 0.75,
      forMinutes: 0,
      // The list's order, whatever order they were chosen in.
      recipients: [LEAD.userId, ONCALL.userId],
    });
    request.flush(alert({ name: 'Slow answers' }));
    await settle();
    answerReload();
    await render(fixture);

    expect(text(fixture)).toContain('The alert "Slow answers" is saved.');
    expect(element(fixture).querySelector('td[colspan]')).toBeNull();
  });

  it('reports how a test email went', async () => {
    const fixture = await open(MANAGER);

    button(fixture, 'Send a test email for High CPU')!.click();
    http.expectOne('/api/v1/company/alerts/al-1/test').flush({ delivered: true, sent: 2, error: null });
    await settle();
    answerReload();
    await render(fixture);
    expect(text(fixture)).toContain('A test email was sent to 2 members.');

    button(fixture, 'Send a test email for High CPU')!.click();
    http.expectOne('/api/v1/company/alerts/al-1/test').flush({ delivered: false, sent: 0, error: 'Mail server unavailable' });
    await settle();
    answerReload();
    await render(fixture);
    expect(text(fixture)).toContain('The test email failed: Mail server unavailable');
  });

  it('turns an alert off, and asks before deleting one', async () => {
    const fixture = await open(MANAGER);

    button(fixture, 'Turn off High CPU')!.click();
    const off = http.expectOne((candidate) => candidate.method === 'PATCH');
    expect(off.request.body).toEqual({ enabled: false });
    off.flush(alert({ enabled: false }));
    await settle();
    answerReload(overview({ alerts: [alert({ enabled: false, state: 'ok' })] }));
    await render(fixture);
    expect(text(fixture)).toContain('is off');
    expect(element(fixture).querySelector('tbody tr')!.getAttribute('data-state')).toBe('off');

    button(fixture, 'Delete High CPU')!.click();
    await render(fixture);
    http.expectNone((candidate) => candidate.method === 'DELETE');
    button(fixture, 'Confirm deletion')!.click();
    http.expectOne((candidate) => candidate.method === 'DELETE').flush(null);
    await settle();
    answerReload(overview({ alerts: [] }), []);
    await render(fixture);

    expect(text(fixture)).toContain('The alert "High CPU" is deleted.');
  });

  it('won’t create an alert that emails nobody, and says when everyone an alert named has left', async () => {
    const fixture = await open(MANAGER, {
      page: overview({ alerts: [alert({ recipients: [], recipientCount: 0 })] }),
    });
    const form = element(fixture).querySelector('form')!;
    await type(fixture, field(form, 'Name'), 'Nobody listens');
    const mine = [...form.querySelectorAll('label.checkbox')].find((label) => label.textContent?.includes(ME.email))!.querySelector('input')!;

    mine.click();
    await render(fixture);

    expect(button(fixture, 'Create alert')!.disabled).toBe(true);
    expect(text(fixture)).toContain('Everyone it named has left the company. Choose someone to email.');
  });

  it('lets an alert email at most 10 members', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ userId: `u-${index}`, displayName: `Person ${index}`, email: `p${index}@example.com` }));
    const fixture = await open(MANAGER, { members: many, page: overview({ alerts: [] }) });
    const boxes = [...element(fixture).querySelectorAll<HTMLInputElement>('form label.checkbox input')];

    for (const box of boxes.slice(0, 10)) {
      box.click();
      await render(fixture);
    }

    expect(boxes.filter((box) => box.checked)).toHaveLength(10);
    expect(boxes.slice(10).every((box) => box.disabled)).toBe(true);
  });

  it('shows when alerts fired, and which still fire', async () => {
    const fixture = await open(['dashboards:view']);

    const history = [...element(fixture).querySelectorAll('section')].find((section) =>
      section.querySelector('h2')?.textContent?.includes('History'),
    )!;
    expect(history.textContent).toContain('Still firing');
    expect(history.textContent).toContain('At 93%');
    expect(history.textContent).toContain('Resolved');
    expect(history.textContent).toContain('At 12%');
  });
});

describe('alert thresholds', () => {
  it('are typed in the unit Monitoring shows, and kept in the API’s', () => {
    expect(inputUnit('bytes')).toBe('MiB');
    expect(inputUnit('seconds')).toBe('ms');
    expect(inputUnit('percent')).toBe('%');
    expect(toThreshold(450, 'bytes')).toBe(450 * MIB);
    expect(toThreshold(0.1, 'seconds')).toBe(0.0001);
    expect(toThreshold(80, 'percent')).toBe(80);
    expect(fromThreshold(512 * MIB, 'bytes')).toBe(512);
    expect(fromThreshold(0.25, 'seconds')).toBe(250);
  });
});

describe('alert events in the audit log', () => {
  const place = { environmentName: 'Production', applicationName: 'Billing API', production: true };

  it('read like sentences', () => {
    expect(describeEvent('AlertCreated', { ...place, name: 'High CPU', condition: 'CPU above 80%' })).toBe(
      'Created the alert "High CPU" on CPU above 80% in the production environment "Production" of "Billing API"',
    );
    expect(describeEvent('AlertUpdated', { ...place, name: 'High CPU', changes: ['threshold', 'recipients'], enabled: true })).toBe(
      'Changed the alert "High CPU" on the production environment "Production" of "Billing API": its threshold and whom it emails',
    );
    expect(describeEvent('AlertUpdated', { ...place, name: 'High CPU', changes: ['enabled'], enabled: false })).toBe(
      'Changed the alert "High CPU" on the production environment "Production" of "Billing API": turned it off',
    );
    expect(describeEvent('AlertTriggered', { ...place, name: 'High CPU', condition: 'CPU above 80%', value: '93%' })).toBe(
      'The alert "High CPU" fired: CPU above 80% in the production environment "Production" of "Billing API", at 93%',
    );
    expect(describeEvent('AlertResolved', { ...place, name: 'High CPU', condition: 'CPU above 80%', value: '12%' })).toBe(
      'The alert "High CPU" was resolved: CPU above 80% no longer holds in the production environment "Production" of "Billing API", at 12%',
    );
    expect(describeEvent('AlertDeleted', { ...place, name: 'High CPU' })).toBe(
      'Deleted the alert "High CPU" on the production environment "Production" of "Billing API"',
    );
    expect(permissionDescription('alerts:manage')).toBe('Manage alerts on metrics, and whom they email');
  });
});
