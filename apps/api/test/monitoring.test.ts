import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApplicationCatalog } from '../src/catalog/application/application-catalog.ts';
import { Entitlements } from '../src/editions/application/entitlements.ts';
import {
  RUNNING_ENVIRONMENTS,
  type RunningEnvironment,
} from '../src/environments/application/running-environments.ts';
import { ApplicationMetrics } from '../src/monitoring/application/application-metrics.ts';
import { METRICS_STORE, MetricsUnavailableError } from '../src/monitoring/application/ports.ts';
import { METRICS, parseRange, TIME_RANGES, windowOf } from '../src/monitoring/domain/metrics.ts';
import { ENVIRONMENT_LABEL, PrometheusMetricsStore } from '../src/monitoring/infrastructure/prometheus-metrics-store.ts';
import { COMPANY_A, COMPANY_B, FakeApplicationCatalog, FakeMetricsStore, FakeRunningEnvironments } from './fakes.ts';
import { HttpStub, type RecordedRequest } from './support/http-stub.ts';
import { signIn as signInAs } from './support/integration.ts';
import { createTestApp } from './test-app.ts';

const BILLING = '00000000-0000-4000-8000-0000000000a1';
const WEBSITE = '00000000-0000-4000-8000-0000000000a2';
const OTHER_APP = '00000000-0000-4000-8000-0000000000b1';
const STAGING = '00000000-0000-4000-8000-0000000000e1';
const PRODUCTION = '00000000-0000-4000-8000-0000000000e2';
const WEBSITE_STAGING = '00000000-0000-4000-8000-0000000000e3';
const IDLE = '00000000-0000-4000-8000-0000000000e4';
const OTHER_COMPANY_ENV = '00000000-0000-4000-8000-0000000000f1';

const NOW = new Date('2026-11-10T12:34:56.000Z');

const inCompany = <T>(companyId: string, work: () => Promise<T>) => runWithCompany(parseCompanyId(companyId), work);

const running = (overrides: Partial<RunningEnvironment>): RunningEnvironment => ({
  environmentId: STAGING,
  environmentName: 'Staging',
  applicationId: BILLING,
  production: false,
  version: '1.4.0-rc.1',
  since: '2026-11-10T09:00:00.000Z',
  address: 'http://localhost:49153',
  targetName: 'This machine',
  ...overrides,
});

/** Two companies: A runs three environments and has one idle, and B runs one. */
function world() {
  const environments = new FakeRunningEnvironments();
  environments.byCompany.set(COMPANY_A, [
    running({ environmentId: PRODUCTION, environmentName: 'Production', production: true, version: '1.3.0' }),
    running({ environmentId: WEBSITE_STAGING, applicationId: WEBSITE, version: '2.0.0-rc.1' }),
    running({}),
    running({ environmentId: IDLE, environmentName: 'Demo', version: null, since: null, address: null, targetName: null }),
  ]);
  environments.byCompany.set(COMPANY_B, [running({ environmentId: OTHER_COMPANY_ENV, applicationId: OTHER_APP })]);
  const catalog = new FakeApplicationCatalog();
  catalog.byCompany.set(COMPANY_A, [
    { id: BILLING, name: 'Billing API', status: 'active' },
    { id: WEBSITE, name: 'Website', status: 'archived' },
  ]);
  catalog.byCompany.set(COMPANY_B, [{ id: OTHER_APP, name: 'Their API', status: 'active' }]);
  const store = new FakeMetricsStore();
  return { environments, catalog, store };
}

const metricsOf = (setup: ReturnType<typeof world>, options: { store?: boolean } = {}) =>
  new ApplicationMetrics(
    setup.environments,
    setup.catalog as unknown as ApplicationCatalog,
    options.store === false ? null : setup.store,
    () => NOW,
  );

describe('metrics', () => {
  it('cover CPU, memory, requests, response times and server errors, each with its unit', () => {
    expect(METRICS.map((metric) => [metric.key, metric.unit])).toEqual([
      ['cpu', 'percent'],
      ['memory', 'bytes'],
      ['requests', 'per-second'],
      ['responseTime', 'seconds'],
      ['errors', 'percent'],
    ]);
  });

  it('are shown over the last hour unless another range is chosen', () => {
    expect(parseRange(undefined)).toBe(TIME_RANGES['1h']);
    expect(parseRange('')).toBe(TIME_RANGES['1h']);
    expect(parseRange('15m')).toBe(TIME_RANGES['15m']);
    expect(parseRange('24h')).toBe(TIME_RANGES['24h']);
    for (const value of ['2h', '1H', 'toString', 15, null]) {
      expect(() => parseRange(value)).toThrow('Choose a range of 15m, 1h, 6h, 24h.');
    }
  });

  it('are charted with about 60 points, ending at the last whole step', () => {
    for (const range of Object.values(TIME_RANGES)) {
      expect(range.seconds / range.stepSeconds).toBe(60);
    }
    expect(windowOf(TIME_RANGES['1h'], NOW)).toEqual({
      start: new Date('2026-11-10T11:34:00.000Z'),
      end: new Date('2026-11-10T12:34:00.000Z'),
      stepSeconds: 60,
    });
  });
});

describe('the metrics of running applications', () => {
  it('list every environment a version runs in, by application, with production last, and their latest metrics', async () => {
    const setup = world();
    setup.store.latestValues.set(STAGING, { cpu: 12.5, memory: 50_000_000, requests: 3, responseTime: 0.12, errors: 0 });
    setup.store.latestValues.set(OTHER_COMPANY_ENV, { cpu: 99, memory: 1, requests: 1, responseTime: 1, errors: 1 });

    const overview = await inCompany(COMPANY_A, () => metricsOf(setup).overview());

    expect(overview.enabled).toBe(true);
    expect(overview.problem).toBeNull();
    expect(overview.metrics).toBe(METRICS);
    expect(overview.environments.map((environment) => [environment.applicationName, environment.environmentName])).toEqual([
      ['Billing API', 'Staging'],
      ['Billing API', 'Production'],
      // Archived applications can still run versions, so they're named too.
      ['Website', 'Staging'],
    ]);
    expect(overview.environments[0]).toEqual({
      environmentId: STAGING,
      environmentName: 'Staging',
      applicationId: BILLING,
      applicationName: 'Billing API',
      production: false,
      version: '1.4.0-rc.1',
      since: '2026-11-10T09:00:00.000Z',
      address: 'http://localhost:49153',
      targetName: 'This machine',
      latest: { cpu: 12.5, memory: 50_000_000, requests: 3, responseTime: 0.12, errors: 0 },
    });
    // An application that sent nothing yet has no values, rather than zeros.
    expect(overview.environments[1]!.latest).toEqual({ cpu: null, memory: null, requests: null, responseTime: null, errors: null });
  });

  it('ask the store only about the company’s own environments that run something', async () => {
    const setup = world();

    await inCompany(COMPANY_A, () => metricsOf(setup).overview());
    await inCompany(COMPANY_B, () => metricsOf(setup).overview());

    expect(setup.store.asked).toEqual([[PRODUCTION, WEBSITE_STAGING, STAGING], [OTHER_COMPANY_ENV]]);
  });

  it('say when the server keeps no metrics, and still list what runs', async () => {
    const setup = world();

    const overview = await inCompany(COMPANY_A, () => metricsOf(setup, { store: false }).overview());

    expect(overview.enabled).toBe(false);
    expect(overview.environments).toHaveLength(3);
    expect(setup.store.asked).toEqual([]);
  });

  it('still list what runs when the store can’t be reached, and say why the numbers are missing', async () => {
    const setup = world();
    setup.store.failure = new MetricsUnavailableError('The metrics store can’t be reached right now. Try again shortly.');

    const overview = await inCompany(COMPANY_A, () => metricsOf(setup).overview());

    expect(overview.problem).toBe('The metrics store can’t be reached right now. Try again shortly.');
    expect(overview.environments).toHaveLength(3);
  });

  it('don’t ask the store anything when nothing runs', async () => {
    const setup = world();
    setup.environments.byCompany.set(COMPANY_A, []);

    const overview = await inCompany(COMPANY_A, () => metricsOf(setup).overview());

    expect(overview.environments).toEqual([]);
    expect(setup.store.asked).toEqual([]);
  });

  it('chart one environment over the chosen range, with gaps where it sent nothing', async () => {
    const setup = world();
    setup.store.seriesValues.set(STAGING, {
      cpu: [
        { at: new Date('2026-11-10T12:33:30.000Z'), value: 10 },
        { at: new Date('2026-11-10T12:34:00.000Z'), value: 20 },
      ],
    });

    const metrics = await inCompany(COMPANY_A, () => metricsOf(setup).environment(STAGING, '15m'));

    expect(metrics.environment).toMatchObject({ environmentId: STAGING, applicationName: 'Billing API', version: '1.4.0-rc.1' });
    expect(metrics.range).toEqual({
      key: '15m',
      start: '2026-11-10T12:19:45.000Z',
      end: '2026-11-10T12:34:45.000Z',
      stepSeconds: 15,
    });
    expect(metrics.series.map((series) => series.key)).toEqual(['cpu', 'memory', 'requests', 'responseTime', 'errors']);
    expect(metrics.series[0]).toEqual({
      ...METRICS[0],
      points: [
        { at: '2026-11-10T12:33:30.000Z', value: 10 },
        { at: '2026-11-10T12:34:00.000Z', value: 20 },
      ],
    });
    expect(metrics.series[1]!.points).toEqual([]);
  });

  it('chart an environment where nothing runs any more, since it may have run recently', async () => {
    const setup = world();

    const metrics = await inCompany(COMPANY_A, () => metricsOf(setup).environment(IDLE, undefined));

    expect(metrics.environment.version).toBeNull();
    expect(metrics.range.key).toBe('1h');
  });

  it('never chart another company’s environment', async () => {
    const setup = world();

    await expect(inCompany(COMPANY_A, () => metricsOf(setup).environment(OTHER_COMPANY_ENV, '1h'))).rejects.toMatchObject({
      kind: 'not-found',
      message: 'There’s no such environment.',
    });
    expect(setup.store.asked).toEqual([]);
  });

  it('explain when the server keeps no metrics, or the store can’t answer', async () => {
    const setup = world();
    await expect(inCompany(COMPANY_A, () => metricsOf(setup, { store: false }).environment(STAGING, '1h'))).rejects.toMatchObject({
      kind: 'unavailable',
      message: 'This server doesn’t keep applications’ metrics. An administrator can set it up with PROMETHEUS_URL.',
    });

    setup.store.failure = new MetricsUnavailableError('The metrics store couldn’t answer (HTTP 503). Try again shortly.');
    await expect(inCompany(COMPANY_A, () => metricsOf(setup).environment(STAGING, '1h'))).rejects.toMatchObject({
      kind: 'unavailable',
      message: 'The metrics store couldn’t answer (HTTP 503). Try again shortly.',
    });
  });

  it('refuse a range it doesn’t offer', async () => {
    const setup = world();

    await expect(inCompany(COMPANY_A, () => metricsOf(setup).environment(STAGING, '7d'))).rejects.toMatchObject({
      kind: 'invalid',
    });
  });
});

describe('the Prometheus metrics store', () => {
  const prometheus = new HttpStub();
  let store: PrometheusMetricsStore;

  /** The PromQL of each query, in the order they were asked. */
  const queries = () => prometheus.requests.map((recorded) => formOf(recorded).get('query') ?? '');

  beforeAll(async () => {
    await prometheus.start();
  });

  beforeEach(() => {
    prometheus.reset();
    store = new PrometheusMetricsStore({ url: `${prometheus.url}/`, timeoutMs: 2_000 });
  });

  afterAll(async () => {
    await prometheus.stop();
  });

  const vector = (values: Record<string, string>) => ({
    status: 'success',
    data: {
      resultType: 'vector',
      result: Object.entries(values).map(([id, value]) => ({ metric: { [ENVIRONMENT_LABEL]: id }, value: [1_700_000_000, value] })),
    },
  });

  it('labels metrics by the attribute the platform gives each environment', () => {
    expect(ENVIRONMENT_LABEL).toBe('dreamdevops_environment_id');
  });

  it('reads the latest value of each metric, for the environments asked about only', async () => {
    prometheus.on('POST', '/api/v1/query', (recorded) => {
      const query = formOf(recorded).get('query')!;
      if (query.includes('process_cpu_time_seconds_total')) {
        return { body: vector({ [STAGING]: '12.5', [OTHER_COMPANY_ENV]: '99' }) };
      }
      if (query.includes('process_memory_usage_bytes')) {
        return { body: vector({ [STAGING]: '52428800', [PRODUCTION]: '1000' }) };
      }
      if (query.startsWith('histogram_quantile')) {
        // No requests in the window, so there's no percentile.
        return { body: vector({ [STAGING]: 'NaN' }) };
      }
      return { body: vector({}) };
    });

    const latest = await store.latest([STAGING, PRODUCTION]);

    expect(Object.fromEntries(latest)).toEqual({
      [STAGING]: { cpu: 12.5, memory: 52_428_800, requests: null, responseTime: null, errors: null },
      [PRODUCTION]: { cpu: null, memory: 1000, requests: null, responseTime: null, errors: null },
    });
    expect(queries()).toHaveLength(5);
    for (const query of queries()) {
      expect(query).toContain(`dreamdevops_environment_id=~"${STAGING}|${PRODUCTION}"`);
    }
  });

  it('asks for the standard OpenTelemetry metrics, as Prometheus names them', async () => {
    prometheus.on('POST', '/api/v1/query', { body: vector({}) });

    await store.latest([STAGING]);

    const selector = `{dreamdevops_environment_id=~"${STAGING}"}`;
    expect(queries()).toEqual([
      `sum by (dreamdevops_environment_id) (rate(process_cpu_time_seconds_total${selector}[120s])) * 100`,
      `sum by (dreamdevops_environment_id) (process_memory_usage_bytes${selector})`,
      `sum by (dreamdevops_environment_id) (rate(http_server_request_duration_seconds_count${selector}[120s]))`,
      `histogram_quantile(0.95, sum by (dreamdevops_environment_id, le) (rate(http_server_request_duration_seconds_bucket${selector}[120s])))`,
      `(sum by (dreamdevops_environment_id) (rate(http_server_request_duration_seconds_count{dreamdevops_environment_id=~"${STAGING}",http_response_status_code=~"5.."}[120s])) or sum by (dreamdevops_environment_id) (rate(http_server_request_duration_seconds_count${selector}[120s])) * 0) / sum by (dreamdevops_environment_id) (rate(http_server_request_duration_seconds_count${selector}[120s])) * 100`,
    ]);
  });

  it('asks nothing when there are no environments', async () => {
    expect((await store.latest([])).size).toBe(0);
    expect(prometheus.requests).toEqual([]);
  });

  it('charts one environment over a window, one point per step, skipping steps with no number', async () => {
    prometheus.on('POST', '/api/v1/query_range', {
      body: {
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { [ENVIRONMENT_LABEL]: STAGING },
              values: [
                [1_762_777_200, '1.5'],
                [1_762_777_260, 'NaN'],
                [1_762_777_320, '2'],
              ],
            },
          ],
        },
      },
    });
    const window = { start: new Date('2026-11-10T12:00:00.000Z'), end: new Date('2026-11-10T13:00:00.000Z'), stepSeconds: 60 };

    const series = await store.series(STAGING, window);

    expect(series.cpu).toEqual([
      { at: new Date(1_762_777_200_000), value: 1.5 },
      { at: new Date(1_762_777_320_000), value: 2 },
    ]);
    const form = formOf(prometheus.requests[0]!);
    expect(form.get('query')).toContain(`{dreamdevops_environment_id="${STAGING}"}[120s]`);
    expect([form.get('start'), form.get('end'), form.get('step')]).toEqual(['1794312000', '1794315600', '60']);
  });

  it('works rates out over at least a step, so long ranges miss nothing between points', async () => {
    prometheus.on('POST', '/api/v1/query_range', { body: { status: 'success', data: { resultType: 'matrix', result: [] } } });
    const window = { start: new Date('2026-11-09T13:00:00.000Z'), end: new Date('2026-11-10T13:00:00.000Z'), stepSeconds: 1440 };

    const series = await store.series(STAGING, window);

    expect(series.requests).toEqual([]);
    expect(queries()[0]).toContain('[1440s]');
  });

  it('says when Prometheus can’t be reached or can’t answer', async () => {
    prometheus.on('POST', '/api/v1/query', { status: 503, body: { status: 'error', error: 'overloaded' } });
    await expect(store.latest([STAGING])).rejects.toThrow(
      new MetricsUnavailableError('The metrics store couldn’t answer (HTTP 503). Try again shortly.'),
    );

    const unreachable = new PrometheusMetricsStore({ url: 'http://127.0.0.1:1', timeoutMs: 2_000 });
    await expect(unreachable.latest([STAGING])).rejects.toThrow(
      new MetricsUnavailableError('The metrics store can’t be reached right now. Try again shortly.'),
    );
  });

  it('never puts anything but an environment ID into a query', async () => {
    await expect(store.latest(['x"} or vector(1) #'])).rejects.toThrow("isn't an environment ID");
    await expect(
      store.series('.*', { start: new Date(0), end: new Date(60_000), stepSeconds: 15 }),
    ).rejects.toThrow("isn't an environment ID");
    expect(prometheus.requests).toEqual([]);
  });
});

describe('monitoring routes', () => {
  let app: INestApplication;
  const setup = world();
  const features: string[] = [];
  let entitled = true;

  beforeAll(async () => {
    const entitlements = {
      isEnabled: async (companyId: string, feature: string) => {
        features.push(`${companyId}:${feature}`);
        return entitled;
      },
    };
    app = await createTestApp({
      config: { secureCookies: false },
      overrides: [
        { provide: RUNNING_ENVIRONMENTS, useValue: setup.environments },
        { provide: ApplicationCatalog, useValue: setup.catalog },
        { provide: METRICS_STORE, useValue: setup.store },
        { provide: Entitlements, useValue: entitlements },
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

  it.each([`/api/v1/company/monitoring/environments`, `/api/v1/company/monitoring/environments/${STAGING}`])(
    'ask anonymous users to sign in: %s',
    async (path) => {
      await request(app.getHttpServer()).get(path).expect(401);
    },
  );

  it('let every member who views dashboards see their own company’s applications', async () => {
    const { body } = await (await signIn('viewer-a')).get('/api/v1/company/monitoring/environments').expect(200);

    expect(body.environments.map((environment: { environmentId: string }) => environment.environmentId)).toEqual([
      STAGING,
      PRODUCTION,
      WEBSITE_STAGING,
    ]);
    expect(features).toContain(`${COMPANY_A}:monitoring`);
  });

  it('chart one environment, and not another company’s', async () => {
    const viewer = await signIn('viewer-a');

    const { body } = await viewer.get(`/api/v1/company/monitoring/environments/${STAGING}?range=6h`).expect(200);
    expect(body.range.key).toBe('6h');

    const { body: refused } = await viewer.get(`/api/v1/company/monitoring/environments/${OTHER_COMPANY_ENV}`).expect(404);
    expect(refused.detail).toBe('There’s no such environment.');
    await (await signIn('viewer-b')).get(`/api/v1/company/monitoring/environments/${OTHER_COMPANY_ENV}`).expect(200);
  });

  it('refuse a range it doesn’t offer', async () => {
    await (await signIn('viewer-a')).get(`/api/v1/company/monitoring/environments/${STAGING}?range=7d`).expect(400);
  });

  it('refuse members who don’t view dashboards, and people with no company', async () => {
    await (await signIn('developer-a')).get('/api/v1/company/monitoring/environments').expect(403);
    await (await signIn('platform-admin')).get('/api/v1/company/monitoring/environments').expect(403);
  });

  it('refuse companies whose edition lacks monitoring', async () => {
    entitled = false;

    const { body } = await (await signIn('viewer-a')).get('/api/v1/company/monitoring/environments').expect(403);

    expect(body.detail).toBe("Your company's edition doesn't include this feature.");
  });
});

function formOf(recorded: RecordedRequest): URLSearchParams {
  return new URLSearchParams(typeof recorded.body === 'string' ? recorded.body : '');
}
