import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SessionService } from '../../core/session.service';
import { settle } from '../../testing';
import { LogView } from './log-view';
import { MetricChart } from './metric-chart';
import { formatDuration, formatLimit, formatMetric, shareOfLimit } from './metric-format';
import type {
  EnvironmentLogs,
  EnvironmentMetrics,
  EnvironmentTraces,
  LogLine,
  MetricDefinition,
  MetricSeries,
  MonitoringOverview,
  Span,
  Trace,
} from './monitoring.api';
import { Monitoring, REFRESH_MS } from './monitoring';
import { TraceView } from './trace-view';

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
  limits: { cpus: 1, memoryBytes: 512 * 1024 * 1024 },
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

const series = (key: MetricSeries['key'], points: MetricSeries['points'], dailyHigh: number | null = null): MetricSeries => ({
  ...METRICS.find((metric) => metric.key === key)!,
  points,
  dailyHigh,
});

const charts = (range: EnvironmentMetrics['range']['key'] = '1h'): EnvironmentMetrics => ({
  environment: row(),
  range: { key: range, start: '2026-11-10T11:00:00.000Z', end: '2026-11-10T12:00:00.000Z', stepSeconds: 60 },
  dailyHigh: { start: '2026-11-09T11:00:00.000Z', end: '2026-11-10T11:00:00.000Z' },
  series: [
    series(
      'cpu',
      [
        { at: '2026-11-10T11:58:00.000Z', value: 10 },
        { at: '2026-11-10T11:59:00.000Z', value: 20 },
      ],
      15,
    ),
    series('memory', [{ at: '2026-11-10T11:59:00.000Z', value: 52_428_800 }], 60 * 1024 * 1024),
    series('requests', []),
    series('responseTime', []),
    series('errors', []),
  ],
});

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

const logLine = (overrides: Partial<LogLine> = {}): LogLine => ({
  at: '2026-11-10T11:59:00.000Z',
  stream: 'stdout',
  level: 'info',
  message: 'Ping received',
  traceId: TRACE_ID,
  spanId: '00f067aa0ba902b7',
  ...overrides,
});

const logs = (overrides: Partial<EnvironmentLogs> = {}): EnvironmentLogs => ({
  environmentId: 'e-1',
  running: true,
  range: { key: '1h', start: '2026-11-10T11:00:00.000Z', end: '2026-11-10T12:00:00.000Z' },
  lines: [
    logLine({ at: '2026-11-10T11:58:00.000Z', level: null, stream: 'stderr', message: 'nginx started', traceId: null, spanId: null }),
    logLine(),
    logLine({ at: '2026-11-10T11:59:30.000Z', level: 'error', message: 'Payment failed', traceId: null, spanId: null }),
  ],
  ...overrides,
});

const traces = (overrides: Partial<EnvironmentTraces> = {}): EnvironmentTraces => ({
  enabled: true,
  serviceName: 'billing-api',
  range: { key: '1h', start: '2026-11-10T11:00:00.000Z', end: '2026-11-10T12:00:00.000Z' },
  traces: [
    {
      traceId: TRACE_ID,
      name: 'GET',
      start: '2026-11-10T11:59:00.000Z',
      durationMs: 12.5,
      spans: 2,
      errors: 1,
      services: ['billing-api'],
    },
  ],
  ...overrides,
});

const spanOf = (overrides: Partial<Span> = {}): Span => ({
  spanId: 'a000000000000001',
  parentSpanId: null,
  name: 'GET /',
  serviceName: 'website',
  environmentId: 'e-3',
  environmentName: 'Staging',
  applicationName: 'Website',
  production: false,
  start: '2026-11-10T11:59:00.000Z',
  offsetMs: 0,
  durationMs: 40,
  kind: 'server',
  error: false,
  attributes: { 'http.request.method': 'GET', 'url.path': '/', 'http.response.status_code': 200 },
  ...overrides,
});

const TRACE: Trace = {
  traceId: TRACE_ID,
  start: '2026-11-10T11:59:00.000Z',
  durationMs: 40,
  spans: [
    spanOf(),
    spanOf({
      spanId: 'a000000000000002',
      parentSpanId: 'a000000000000001',
      name: 'GET',
      serviceName: 'billing-api',
      environmentId: 'e-1',
      applicationName: 'Billing API',
      offsetMs: 10,
      durationMs: 20,
      error: true,
      attributes: { 'http.request.method': 'GET', 'http.route': '/api/ping', 'http.response.status_code': 500 },
    }),
  ],
  hiddenSpans: 1,
};

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
  const rows = (fixture: ComponentFixture<unknown>, selector = '.monitoring-table tbody tr') =>
    [...element(fixture).querySelectorAll(selector)].map((tableRow) =>
      [...tableRow.querySelectorAll('td')].map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()),
    );
  const button = (fixture: ComponentFixture<unknown>, label: string) =>
    [...element(fixture).querySelectorAll('button')].find(
      (candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label,
    )!;

  const open = async (answer: MonitoringOverview = overview()) => {
    const fixture = TestBed.createComponent(Monitoring);
    fixture.detectChanges();
    http.expectOne(OVERVIEW_URL).flush(answer);
    await render(fixture);
    return fixture;
  };

  /** Opens an environment's details, and answers for its metrics, unless the server keeps none, logs and traces. */
  const details = async (
    fixture: ComponentFixture<unknown>,
    label = 'Show details of Billing API in Staging',
    answers: { charts?: EnvironmentMetrics | null; logs?: EnvironmentLogs; traces?: EnvironmentTraces; range?: string } = {},
  ) => {
    const id = label.includes('Production') ? 'e-2' : label.includes('Website') ? 'e-3' : 'e-1';
    const range = answers.range ?? '1h';
    button(fixture, label).click();
    await render(fixture);
    if (answers.charts !== null) {
      http.expectOne(`${OVERVIEW_URL}/${id}?range=${range}`).flush(answers.charts ?? charts());
    }
    http.expectOne(`${OVERVIEW_URL}/${id}/logs?range=${range}`).flush(answers.logs ?? logs());
    http.expectOne(`${OVERVIEW_URL}/${id}/traces?range=${range}`).flush(answers.traces ?? traces());
    await render(fixture);
  };

  it('offers those who manage alerts to set one up on the environment they look at', async () => {
    const plain = await open();
    await details(plain);
    expect(text(plain)).not.toContain('Set up an alert');
    plain.destroy();

    vi.spyOn(TestBed.inject(SessionService), 'can').mockImplementation((permission) => permission === 'alerts:manage');
    const fixture = await open();
    await details(fixture);

    const link = [...element(fixture).querySelectorAll('a')].find((anchor) => anchor.textContent?.trim() === 'Set up an alert')!;
    expect(link.getAttribute('href')).toBe('/alerts?environment=e-1');
  });

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
      [
        'Billing API',
        'Staging 1.4.0-rc.1 on This machine',
        '13% of 1 CPU',
        '50.0 MiB of 512 MiB, 10%',
        '3.3/s',
        '84 ms',
        '0%',
        'Show details',
      ],
      [
        'Billing API',
        'Production Production 1.3.0 on This machine',
        '40% of 1 CPU',
        '76.3 MiB of 512 MiB, 15%',
        '12/s',
        '1.50 s',
        '2.5%',
        'Show details',
      ],
      [
        'Website',
        'Staging 2.0.0 on This machine No metrics received yet.',
        'No data Limit: 1 CPU',
        'No data Limit: 512 MiB',
        'No data',
        'No data',
        'No data',
        'Show details',
      ],
    ]);
    expect(element(fixture).querySelector('.cell-note[data-tone="danger"]')).toBeNull();
    expect(element(fixture).querySelector('tr[data-production="true"] .status')?.textContent?.trim()).toBe('Production');
  });

  it('makes CPU and memory close to their container’s limits stand out', async () => {
    const fixture = await open(
      overview({ environments: [row({ latest: { cpu: 95, memory: 500 * 1024 * 1024, requests: 1, responseTime: 0.1, errors: 0 } })] }),
    );

    const near = [...element(fixture).querySelectorAll('.cell-note[data-tone="danger"]')].map((note) => note.textContent?.trim());
    expect(near).toEqual(['of 1 CPU', 'of 512 MiB, 98%']);
  });

  it('shows no limits where they aren’t known', async () => {
    const fixture = await open(overview({ environments: [row({ limits: null })] }));

    expect(rows(fixture)[0]!.slice(2, 4)).toEqual(['13%', '50.0 MiB']);
  });

  it('says when the server keeps no metrics, and still shows logs and traces', async () => {
    const fixture = await open(overview({ enabled: false, environments: [row({ latest: NOTHING })] }));

    expect(element(fixture).querySelector('[role="status"]')?.textContent).toContain(
      "This server doesn't keep applications' metrics yet",
    );
    expect(text(fixture)).not.toContain('No metrics received yet.');
    await details(fixture, 'Show details of Billing API in Staging', { charts: null });

    expect(text(fixture)).toContain("This server doesn't keep metrics yet.");
    expect(element(fixture).querySelectorAll('.log-line')).toHaveLength(3);
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

  it('shows one environment’s charts, logs and traces on request, over the range chosen, and hides them again', async () => {
    const fixture = await open();

    await details(fixture);

    expect(element(fixture).querySelector('#details-heading')?.textContent).toBe('Billing API in Staging');
    expect(text(fixture)).toContain('Its container may use at most 1 CPU and 512 MiB of memory, on This machine.');
    expect([...element(fixture).querySelectorAll('app-metric-chart .cell-note')].map((note) => note.textContent?.trim()).slice(0, 2)).toEqual([
      'Highest 20%, of a limit of 1 CPU. How much of one CPU core it uses.',
      'Highest 50.0 MiB, of a limit of 512 MiB. How much memory it holds.',
    ]);
    expect([...element(fixture).querySelectorAll('[aria-labelledby="details-heading"] h3')].map((heading) => heading.textContent)).toEqual([
      'Metrics',
      'Logs',
      'Traces',
    ]);
    expect([...element(fixture).querySelectorAll('.metric-chart-name')].map((name) => name.textContent)).toEqual([
      'CPU',
      'Memory',
      'Requests',
      'Response time',
      'Server errors',
    ]);
    expect(element(fixture).querySelectorAll('.log-line')).toHaveLength(3);
    expect(rows(fixture, 'app-trace-list tbody tr')).toEqual([
      [expect.stringMatching(/^Nov 10, /), `GET 1 error ${TRACE_ID}`, '13 ms', '2', 'Show trace'],
    ]);
    expect(button(fixture, 'Hide details of Billing API in Staging').getAttribute('aria-expanded')).toBe('true');

    const select = element(fixture).querySelector<HTMLSelectElement>('.monitoring-charts-header select')!;
    select.value = '24h';
    select.dispatchEvent(new Event('change'));
    await render(fixture);
    http.expectOne(`${OVERVIEW_URL}/e-1?range=24h`).flush(charts('24h'));
    http.expectOne(`${OVERVIEW_URL}/e-1/logs?range=24h`).flush(logs());
    http.expectOne(`${OVERVIEW_URL}/e-1/traces?range=24h`).flush(traces());
    await render(fixture);
    expect(element(fixture).querySelectorAll('app-metric-chart')).toHaveLength(5);

    button(fixture, 'Hide details of Billing API in Staging').click();
    await render(fixture);
    expect(element(fixture).querySelector('#details-heading')).toBeNull();
  });

  it('explains what can’t be read, and shows the rest', async () => {
    const fixture = await open();

    button(fixture, 'Show details of Billing API in Production').click();
    await render(fixture);
    http
      .expectOne(`${OVERVIEW_URL}/e-2?range=1h`)
      .flush({ detail: 'The metrics store couldn’t answer (HTTP 503). Try again shortly.' }, { status: 503, statusText: 'Unavailable' });
    http
      .expectOne(`${OVERVIEW_URL}/e-2/logs?range=1h`)
      .flush({ detail: 'The logs can’t be read from This machine right now.' }, { status: 503, statusText: 'Unavailable' });
    http.expectOne(`${OVERVIEW_URL}/e-2/traces?range=1h`).flush(traces({ enabled: false, traces: [] }));
    await render(fixture);

    const alerts = [...element(fixture).querySelectorAll('section [role="alert"]')].map((alert) => alert.textContent?.trim());
    expect(alerts).toEqual([
      'The metrics store couldn’t answer (HTTP 503). Try again shortly.',
      'The logs can’t be read from This machine right now.',
    ]);
    expect(text(fixture)).toContain("This server doesn't keep traces yet.");
  });

  it('says when nothing runs to write logs', async () => {
    const fixture = await open();

    await details(fixture, 'Show details of Billing API in Staging', { logs: logs({ running: false, lines: [] }) });

    expect(text(fixture)).toContain('Nothing runs here, so nothing is written.');
  });

  it('opens the trace a log line was written in, with the company’s spans as a timeline, and closes it', async () => {
    const fixture = await open();
    await details(fixture);

    button(fixture, `Show trace ${TRACE_ID}`).click();
    await render(fixture);
    http.expectOne(`/api/v1/company/monitoring/traces/${TRACE_ID}`).flush(TRACE);
    await render(fixture);

    expect(element(fixture).querySelector('#trace-heading')?.textContent).toBe(`Trace ${TRACE_ID}`);
    expect(element(fixture).querySelectorAll('.trace-span')).toHaveLength(2);
    expect(text(fixture)).toContain("1 span from outside your company's applications aren't shown.");

    button(fixture, 'Close trace').click();
    await render(fixture);
    expect(element(fixture).querySelector('#trace-heading')).toBeNull();
  });

  it('opens a trace from the list of traces, and says when it can’t be shown', async () => {
    const fixture = await open();
    await details(fixture);

    [...element(fixture).querySelectorAll<HTMLButtonElement>('app-trace-list button')][0]!.click();
    await render(fixture);
    http
      .expectOne(`/api/v1/company/monitoring/traces/${TRACE_ID}`)
      .flush({ detail: 'There’s no such trace, or none of it comes from your applications.' }, { status: 404, statusText: 'Not Found' });
    await render(fixture);

    expect(element(fixture).querySelector('[aria-labelledby="trace-heading"] [role="alert"]')?.textContent).toContain(
      'There’s no such trace, or none of it comes from your applications.',
    );
  });

  it('reads the metrics, and the details on screen, again every 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = TestBed.createComponent(Monitoring);
    fixture.detectChanges();
    http.expectOne(OVERVIEW_URL).flush(overview());
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    button(fixture, 'Show details of Billing API in Staging').click();
    await vi.advanceTimersByTimeAsync(0);
    const answerDetails = async () => {
      http.expectOne(`${OVERVIEW_URL}/e-1?range=1h`).flush(charts());
      http.expectOne(`${OVERVIEW_URL}/e-1/logs?range=1h`).flush(logs());
      http.expectOne(`${OVERVIEW_URL}/e-1/traces?range=1h`).flush(traces());
      await vi.advanceTimersByTimeAsync(0);
    };
    await answerDetails();

    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    http.expectOne(OVERVIEW_URL).flush(overview({ environments: [row({ latest: { ...NOTHING, cpu: 99 } })] }));
    await vi.advanceTimersByTimeAsync(0);
    await answerDetails();
    fixture.detectChanges();

    expect(rows(fixture)[0]![2]).toBe('99% of 1 CPU');
    expect(element(fixture).querySelector('.cell-note[data-tone="danger"]')?.textContent?.trim()).toBe('of 1 CPU');
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    http.expectNone(OVERVIEW_URL);
  });
});

describe('the log view', () => {
  const show = async (lines: readonly LogLine[]) => {
    const fixture = TestBed.createComponent(LogView);
    fixture.componentRef.setInput('lines', lines);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  };
  const shown = (fixture: ComponentFixture<LogView>) =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll('.log-line')].map((line) => [
      line.getAttribute('data-level'),
      line.querySelector('.log-level')?.textContent?.trim(),
      line.querySelector('.log-message')?.textContent?.trim(),
    ]);

  it('shows the newest line first, with its level, or the error output it came from', async () => {
    const fixture = await show(logs().lines);

    expect(shown(fixture)).toEqual([
      ['error', 'error', 'Payment failed'],
      ['info', 'info', 'Ping received'],
      ['stderr', 'stderr', 'nginx started'],
    ]);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('3 of 3 lines, newest first');
  });

  it('narrows the lines by text, level or trace ID', async () => {
    const fixture = await show(logs().lines);
    const filter = (fixture.nativeElement as HTMLElement).querySelector('input')!;

    for (const [value, expected] of [
      ['PAYMENT', ['Payment failed']],
      ['error', ['Payment failed']],
      [TRACE_ID.slice(0, 8), ['Ping received']],
      ['nothing like it', []],
    ] as const) {
      filter.value = value;
      filter.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      await fixture.whenStable();
      expect(shown(fixture).map(([, , message]) => message)).toEqual(expected);
    }
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No line matches the filter.');
  });

  it('offers the trace of lines written in one', async () => {
    const fixture = await show(logs().lines);
    const opened: string[] = [];
    fixture.componentInstance.openTrace.subscribe((traceId) => opened.push(traceId));

    const traceButtons = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.log-trace');
    expect(traceButtons).toHaveLength(1);
    traceButtons[0]!.click();

    expect(opened).toEqual([TRACE_ID]);
  });
});

describe('the trace view', () => {
  it('puts each span under the one it’s part of, with a bar for when it ran, and what it did', async () => {
    const fixture = TestBed.createComponent(TraceView);
    fixture.componentRef.setInput('trace', TRACE);
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    const spans = [...element.querySelectorAll<HTMLElement>('.trace-span')].map((span) => ({
      label: span.querySelector('.trace-span-label')!.textContent!.replace(/\s+/g, ' ').trim(),
      indent: span.querySelector<HTMLElement>('.trace-span-label')!.style.paddingLeft,
      left: span.querySelector<HTMLElement>('.trace-span-bar')!.style.left,
      width: span.querySelector<HTMLElement>('.trace-span-bar')!.style.width,
      error: span.getAttribute('data-error'),
      took: span.querySelector('.trace-span-duration')!.textContent,
    }));

    expect(spans).toEqual([
      { label: 'GET / Website in Staging server GET / 200', indent: '0rem', left: '0%', width: '100%', error: 'false', took: '40 ms' },
      {
        label: 'GET Billing API in Staging Error server GET /api/ping 500',
        indent: '1rem',
        left: '25%',
        width: '50%',
        error: 'true',
        took: '20 ms',
      },
    ]);
    expect(element.textContent).toContain('Took 40 ms, in 2 spans.');
  });

  it('starts a branch for a span whose parent isn’t shown, such as a browser’s', async () => {
    const fixture = TestBed.createComponent(TraceView);
    fixture.componentRef.setInput('trace', { ...TRACE, spans: [spanOf({ parentSpanId: 'ffffffffffffffff' })], hiddenSpans: 0 });
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector<HTMLElement>('.trace-span-label')!.style.paddingLeft).toBe('0rem');
    expect(element.textContent).not.toContain("aren't shown");
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
    expect(element.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'CPU: latest 25%, highest 50%, no daily high yet, over 3 points',
    );
    expect(element.querySelector('.metric-chart-daily-high')).toBeNull();
    expect(element.querySelector('.metric-chart-daily-high-note')?.textContent?.trim()).toBe(
      'No daily high yet: nothing was sent the day before.',
    );
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

  it('marks the daily high with an orange line, where it sits among the points', async () => {
    const element = await draw(
      series(
        'cpu',
        [
          { at: '2026-11-10T11:00:00.000Z', value: 10 },
          { at: '2026-11-10T11:01:00.000Z', value: 50 },
          { at: '2026-11-10T11:02:00.000Z', value: 20 },
        ],
        25,
      ),
    );

    const line = element.querySelector('.metric-chart-daily-high')!;
    // Halfway up the chart, as 25 is half of the highest point, 50.
    expect([line.getAttribute('x1'), line.getAttribute('x2'), line.getAttribute('y1'), line.getAttribute('y2')]).toEqual([
      '0',
      '300',
      '40',
      '40',
    ]);
    expect(line.querySelector('title')?.textContent).toBe('Daily high: 25%');
    const note = element.querySelector('.metric-chart-daily-high-note')!;
    expect(note.textContent?.replace(/\s+/g, ' ').trim()).toBe('Daily high 25%. Went above it in this range.');
    expect(note.getAttribute('data-above')).toBe('earlier');
  });

  it('says when the latest value is above the daily high', async () => {
    const element = await draw(
      series(
        'memory',
        [
          { at: '2026-11-10T11:00:00.000Z', value: 100 * 1024 * 1024 },
          { at: '2026-11-10T11:01:00.000Z', value: 300 * 1024 * 1024 },
        ],
        200 * 1024 * 1024,
      ),
    );

    expect(element.querySelector('.metric-chart-daily-high-note')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Daily high 200.0 MiB. Now above it.',
    );
    expect(element.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Memory: latest 300.0 MiB, highest 300.0 MiB, daily high 200.0 MiB, now above it, over 2 points',
    );
  });

  it('fits a daily high above every point, so the line stays on the chart, and says nothing went above it', async () => {
    const element = await draw(
      series(
        'requests',
        [
          { at: '2026-11-10T11:00:00.000Z', value: 1 },
          { at: '2026-11-10T11:01:00.000Z', value: 2 },
        ],
        4,
      ),
    );

    // The chart's top is the daily high, 4, so it sits at the top, and 2 sits halfway.
    expect(element.querySelector('.metric-chart-daily-high')?.getAttribute('y1')).toBe('4');
    expect(lines(element)).toEqual(['0,58 5,40']);
    const note = element.querySelector('.metric-chart-daily-high-note')!;
    expect(note.textContent?.replace(/\s+/g, ' ').trim()).toBe('Daily high 4.0/s.');
    expect(note.hasAttribute('data-above')).toBe(false);
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
    expect(formatMetric(52_428_800, 'bytes')).toBe('50.0 MiB');
    expect(formatMetric(3 * 1024 * 1024 * 1024, 'bytes')).toBe('3.00 GiB');
    expect(formatMetric(0.2, 'per-second')).toBe('0.20/s');
    expect(formatMetric(0.084, 'seconds')).toBe('84 ms');
    expect(formatMetric(2.345, 'seconds')).toBe('2.35 s');
  });

  it('are measured against their container’s limits, for CPU and memory', () => {
    const limits = { cpus: 1, memoryBytes: 512 * 1024 * 1024 };

    expect([formatLimit('cpu', limits), formatLimit('memory', limits), formatLimit('requests', limits)]).toEqual(['1 CPU', '512 MiB', null]);
    expect(formatLimit('cpu', { cpus: 0.5, memoryBytes: 2 * 1024 * 1024 * 1024 })).toBe('0.5 CPUs');
    expect(formatLimit('memory', { cpus: 0.5, memoryBytes: 2 * 1024 * 1024 * 1024 })).toBe('2 GiB');
    expect(formatLimit('cpu', null)).toBeNull();
    expect(shareOfLimit(50, 'cpu', { cpus: 2, memoryBytes: 1 })).toBe(0.25);
    expect(shareOfLimit(256 * 1024 * 1024, 'memory', limits)).toBe(0.5);
    expect(shareOfLimit(null, 'memory', limits)).toBeNull();
    expect(shareOfLimit(10, 'errors', limits)).toBeNull();
  });

  it('give lengths of time in milliseconds, or seconds once they’re long', () => {
    expect(formatDuration(0.42)).toBe('0.4 ms');
    expect(formatDuration(8.24)).toBe('8.2 ms');
    expect(formatDuration(12.5)).toBe('13 ms');
    expect(formatDuration(84.4)).toBe('84 ms');
    expect(formatDuration(1_250)).toBe('1.25 s');
  });
});
