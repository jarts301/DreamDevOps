import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { settle } from '../../testing';
import { MetricChart } from './metric-chart';
import { formatMetric } from './metric-format';
import type { EnvironmentMetrics, MetricDefinition, MetricSeries, MonitoringOverview } from './monitoring.api';
import { Monitoring, REFRESH_MS } from './monitoring';

const OVERVIEW_URL = '/api/v1/company/monitoring/environments';

const METRICS: MetricDefinition[] = [
  { key: 'cpu', name: 'CPU', unit: 'percent', description: 'How much of one CPU core it uses.' },
  { key: 'memory', name: 'Memory', unit: 'bytes', description: 'How much memory it holds.' },
  { key: 'requests', name: 'Requests', unit: 'per-second', description: 'HTTP requests it answers each second.' },
  { key: 'responseTime', name: 'Response time', unit: 'seconds', description: 'The time within which it answers 95% of requests.' },
  { key: 'errors', name: 'Server errors', unit: 'percent', description: 'The share of requests it answers with a 5xx error.' },
];

const NOTHING = { cpu: null, memory: null, requests: null, responseTime: null, errors: null };

const row = (overrides: Partial<MonitoringOverview['environments'][number]> = {}): MonitoringOverview['environments'][number] => ({
  environmentId: 'e-1',
  environmentName: 'Staging',
  applicationId: 'a-1',
  applicationName: 'Billing API',
  production: false,
  version: '1.4.0-rc.1',
  since: '2026-11-10T09:00:00Z',
  address: 'http://localhost:49153',
  targetName: 'This machine',
  latest: { cpu: 12.5, memory: 52_428_800, requests: 3.25, responseTime: 0.084, errors: 0 },
  ...overrides,
});

const overview = (overrides: Partial<MonitoringOverview> = {}): MonitoringOverview => ({
  enabled: true,
  problem: null,
  metrics: METRICS,
  environments: [
    row(),
    row({
      environmentId: 'e-2',
      environmentName: 'Production',
      production: true,
      version: '1.3.0',
      latest: { cpu: 40, memory: 80_000_000, requests: 12, responseTime: 1.5, errors: 2.5 },
    }),
    row({ environmentId: 'e-3', applicationId: 'a-2', applicationName: 'Website', version: '2.0.0', latest: NOTHING }),
  ],
  ...overrides,
});

const series = (key: MetricSeries['key'], points: MetricSeries['points']): MetricSeries => ({
  ...METRICS.find((metric) => metric.key === key)!,
  points,
});

const charts = (range: EnvironmentMetrics['range']['key'] = '1h'): EnvironmentMetrics => ({
  environment: row(),
  range: { key: range, start: '2026-11-10T11:00:00.000Z', end: '2026-11-10T12:00:00.000Z', stepSeconds: 60 },
  series: [
    series('cpu', [
      { at: '2026-11-10T11:58:00.000Z', value: 10 },
      { at: '2026-11-10T11:59:00.000Z', value: 20 },
    ]),
    series('memory', [{ at: '2026-11-10T11:59:00.000Z', value: 52_428_800 }]),
    series('requests', []),
    series('responseTime', []),
    series('errors', []),
  ],
});

describe('monitoring', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.useRealTimers();
    http.verify();
  });

  const element = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
  const text = (fixture: ComponentFixture<unknown>) => (element(fixture).textContent ?? '').replace(/\s+/g, ' ');
  const render = async (fixture: ComponentFixture<unknown>) => {
    await settle();
    await fixture.whenStable();
  };
  const rows = (fixture: ComponentFixture<unknown>) =>
    [...element(fixture).querySelectorAll('tbody tr')].map((tableRow) =>
      [...tableRow.querySelectorAll('td')].map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()),
    );
  const button = (fixture: ComponentFixture<unknown>, label: string) =>
    [...element(fixture).querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label') === label)!;

  const open = async (answer: MonitoringOverview = overview()) => {
    const fixture = TestBed.createComponent(Monitoring);
    fixture.detectChanges();
    http.expectOne(OVERVIEW_URL).flush(answer);
    await render(fixture);
    return fixture;
  };

  it('lists what runs in each environment, with its latest metrics in their units', async () => {
    const fixture = await open();

    expect([...element(fixture).querySelectorAll('thead th')].map((cell) => cell.textContent?.trim())).toEqual([
      'Application',
      'Environment',
      'CPU',
      'Memory',
      'Requests',
      'Response time',
      'Server errors',
      'Actions',
    ]);
    expect(rows(fixture)).toEqual([
      ['Billing API', 'Staging 1.4.0-rc.1 on This machine', '13%', '52.4 MB', '3.3/s', '84 ms', '0%', 'Show charts'],
      ['Billing API', 'Production Production 1.3.0 on This machine', '40%', '80.0 MB', '12/s', '1.50 s', '2.5%', 'Show charts'],
      [
        'Website',
        'Staging 2.0.0 on This machine No metrics received yet.',
        'No data',
        'No data',
        'No data',
        'No data',
        'No data',
        'Show charts',
      ],
    ]);
    expect(element(fixture).querySelector('tr[data-production="true"] .status')?.textContent?.trim()).toBe('Production');
  });

  it('says when the server keeps no metrics, and offers no charts', async () => {
    const fixture = await open(
      overview({ enabled: false, environments: [row({ latest: NOTHING })] }),
    );

    expect(element(fixture).querySelector('[role="status"]')?.textContent).toContain(
      "This server doesn't keep applications' metrics yet",
    );
    expect(text(fixture)).not.toContain('No metrics received yet.');
    expect(element(fixture).querySelectorAll('tbody button')).toHaveLength(0);
  });

  it('still lists what runs when the metrics can’t be read, and says why', async () => {
    const fixture = await open(
      overview({ problem: 'The metrics store can’t be reached right now. Try again shortly.', environments: [row({ latest: NOTHING })] }),
    );

    expect(element(fixture).querySelector('[role="alert"]')?.textContent).toContain(
      'The metrics store can’t be reached right now. Try again shortly.',
    );
    expect(rows(fixture)).toHaveLength(1);
    expect(text(fixture)).not.toContain('No metrics received yet.');
  });

  it('points to the Environments page when nothing runs', async () => {
    const fixture = await open(overview({ environments: [] }));

    expect(element(fixture).querySelector('.empty-state')?.textContent).toContain('Nothing runs in your environments yet.');
    expect(element(fixture).querySelector('.empty-state a')?.getAttribute('href')).toBe('/environments');
  });

  it('explains a failure to load', async () => {
    const fixture = TestBed.createComponent(Monitoring);
    fixture.detectChanges();
    http.expectOne(OVERVIEW_URL).flush({ detail: "Your company's edition doesn't include this feature." }, { status: 403, statusText: 'Forbidden' });
    await render(fixture);

    expect(element(fixture).querySelector('[role="alert"]')?.textContent).toContain(
      "Your company's edition doesn't include this feature.",
    );
  });

  it('charts one environment on request, over the range chosen, and hides them again', async () => {
    const fixture = await open();

    button(fixture, 'Show charts of Billing API in Staging').click();
    await render(fixture);
    expect(text(fixture)).toContain('Loading…');
    http.expectOne(`${OVERVIEW_URL}/e-1?range=1h`).flush(charts());
    await render(fixture);

    expect(element(fixture).querySelector('#charts-heading')?.textContent).toBe('Billing API in Staging');
    expect([...element(fixture).querySelectorAll('.metric-chart-name')].map((name) => name.textContent)).toEqual([
      'CPU',
      'Memory',
      'Requests',
      'Response time',
      'Server errors',
    ]);
    expect(button(fixture, 'Hide charts of Billing API in Staging').getAttribute('aria-expanded')).toBe('true');

    const select = element(fixture).querySelector<HTMLSelectElement>('.monitoring-charts-header select')!;
    select.value = '24h';
    select.dispatchEvent(new Event('change'));
    await render(fixture);
    http.expectOne(`${OVERVIEW_URL}/e-1?range=24h`).flush(charts('24h'));
    await render(fixture);
    expect(element(fixture).querySelectorAll('app-metric-chart')).toHaveLength(5);

    button(fixture, 'Hide charts of Billing API in Staging').click();
    await render(fixture);
    expect(element(fixture).querySelector('#charts-heading')).toBeNull();
  });

  it('explains when the charts can’t be read', async () => {
    const fixture = await open();

    button(fixture, 'Show charts of Billing API in Production').click();
    await render(fixture);
    http
      .expectOne(`${OVERVIEW_URL}/e-2?range=1h`)
      .flush({ detail: 'The metrics store couldn’t answer (HTTP 503). Try again shortly.' }, { status: 503, statusText: 'Unavailable' });
    await render(fixture);

    expect(element(fixture).querySelector('section [role="alert"]')?.textContent).toContain(
      'The metrics store couldn’t answer (HTTP 503). Try again shortly.',
    );
  });

  it('reads the metrics, and the charts on screen, again every 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = TestBed.createComponent(Monitoring);
    fixture.detectChanges();
    http.expectOne(OVERVIEW_URL).flush(overview());
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    button(fixture, 'Show charts of Billing API in Staging').click();
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne(`${OVERVIEW_URL}/e-1?range=1h`).flush(charts());
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    http.expectOne(OVERVIEW_URL).flush(overview({ environments: [row({ latest: { ...NOTHING, cpu: 99 } })] }));
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne(`${OVERVIEW_URL}/e-1?range=1h`).flush(charts());
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();

    expect(rows(fixture)[0]![2]).toBe('99%');
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    http.expectNone(OVERVIEW_URL);
  });
});

describe('a metric chart', () => {
  const draw = async (value: MetricSeries, stepSeconds = 60) => {
    const fixture = TestBed.createComponent(MetricChart);
    fixture.componentRef.setInput('series', value);
    fixture.componentRef.setInput('start', '2026-11-10T11:00:00.000Z');
    fixture.componentRef.setInput('end', '2026-11-10T12:00:00.000Z');
    fixture.componentRef.setInput('stepSeconds', stepSeconds);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  };
  const lines = (element: HTMLElement) => [...element.querySelectorAll('polyline')].map((line) => line.getAttribute('points'));

  it('draws each point where it happened, scaled to the highest value, with the latest value beside its name', async () => {
    const element = await draw(
      series('cpu', [
        { at: '2026-11-10T11:00:00.000Z', value: 0 },
        { at: '2026-11-10T11:01:00.000Z', value: 50 },
        { at: '2026-11-10T11:02:00.000Z', value: 25 },
      ]),
    );

    expect(element.querySelector('figcaption')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('CPU 25%');
    expect(lines(element)).toEqual(['0,76 5,4 10,40']);
    expect(element.querySelector('svg')?.getAttribute('aria-label')).toBe('CPU: latest 25%, highest 50%, over 3 points');
    expect(element.textContent).toContain('Highest 50%. How much of one CPU core it uses.');
  });

  it('breaks the line where the application sent nothing, so a gap never looks like a steady value', async () => {
    const element = await draw(
      series('requests', [
        { at: '2026-11-10T11:00:00.000Z', value: 1 },
        { at: '2026-11-10T11:01:00.000Z', value: 1 },
        { at: '2026-11-10T11:30:00.000Z', value: 1 },
      ]),
    );

    expect(lines(element)).toEqual(['0,4 5,4', '150,4 152,4']);
  });

  it('says when there’s nothing in the range', async () => {
    const element = await draw(series('memory', []));

    expect(element.querySelector('svg')).toBeNull();
    expect(element.textContent).toContain('No data in this range.');
    expect(element.querySelector('.metric-chart-latest')?.textContent).toBe('No data');
  });
});

describe('metric values', () => {
  it('read in their units, with fewer decimals as they grow', () => {
    expect(formatMetric(null, 'percent')).toBe('No data');
    expect(formatMetric(0, 'percent')).toBe('0%');
    expect(formatMetric(0.042, 'percent')).toBe('0.04%');
    expect(formatMetric(2.5, 'percent')).toBe('2.5%');
    expect(formatMetric(87.6, 'percent')).toBe('88%');
    expect(formatMetric(52_428_800, 'bytes')).toBe('52.4 MB');
    expect(formatMetric(0.2, 'per-second')).toBe('0.20/s');
    expect(formatMetric(0.084, 'seconds')).toBe('84 ms');
    expect(formatMetric(2.345, 'seconds')).toBe('2.35 s');
  });
});
