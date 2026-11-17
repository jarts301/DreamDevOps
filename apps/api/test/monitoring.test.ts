import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bytes, cpuCores } from '../src/monitoring/application/running-places.ts';
import { MetricsUnavailableError } from '../src/monitoring/application/ports.ts';
import { METRICS, parseRange, TIME_RANGES, windowOf } from '../src/monitoring/domain/metrics.ts';
import { LokiLogStore, PLACE_LOG_LABEL } from '../src/monitoring/infrastructure/loki-log-store.ts';
import { PLACE_LABEL, PrometheusMetricsStore } from '../src/monitoring/infrastructure/prometheus-metrics-store.ts';
import { HttpStub, type RecordedRequest } from './support/http-stub.ts';

const NOW = new Date('2026-11-10T12:34:56.000Z');
// Places: one application in one environment each.
const STAGING = '00000000-0000-8000-8000-0000000000e1';
const PRODUCTION = '00000000-0000-8000-8000-0000000000e2';
const OTHER_COMPANY_ENV = '00000000-0000-8000-8000-0000000000f1';

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
      result: Object.entries(values).map(([id, value]) => ({ metric: { [PLACE_LABEL]: id }, value: [1_700_000_000, value] })),
    },
  });

  it('labels metrics by the place the platform gives each application in each environment', () => {
    expect(PLACE_LABEL).toBe('dreamdevops_place_id');
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
      expect(query).toContain(`dreamdevops_place_id=~"${STAGING}|${PRODUCTION}"`);
    }
  });

  it('asks for the standard OpenTelemetry metrics, as Prometheus names them', async () => {
    prometheus.on('POST', '/api/v1/query', { body: vector({}) });

    await store.latest([STAGING]);

    const selector = `{dreamdevops_place_id=~"${STAGING}"}`;
    expect(queries()).toEqual([
      `max by (dreamdevops_place_id) (rate(process_cpu_time_seconds_total${selector}[120s])) * 100`,
      `max by (dreamdevops_place_id) (process_memory_usage_bytes${selector})`,
      `sum by (dreamdevops_place_id) (rate(http_server_request_duration_seconds_count${selector}[120s]))`,
      `histogram_quantile(0.95, sum by (dreamdevops_place_id, le) (rate(http_server_request_duration_seconds_bucket${selector}[120s])))`,
      `(sum by (dreamdevops_place_id) (rate(http_server_request_duration_seconds_count{dreamdevops_place_id=~"${STAGING}",http_response_status_code=~"5.."}[120s])) or sum by (dreamdevops_place_id) (rate(http_server_request_duration_seconds_count${selector}[120s])) * 0) / sum by (dreamdevops_place_id) (rate(http_server_request_duration_seconds_count${selector}[120s])) * 100`,
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
              metric: { [PLACE_LABEL]: STAGING },
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
    prometheus.on('POST', '/api/v1/query', (recorded) => ({
      body: formOf(recorded).get('query')!.includes('process_cpu_time_seconds_total')
        ? vector({ [STAGING]: '1.75' })
        : vector({ [STAGING]: 'NaN' }),
    }));
    const window = { start: new Date('2026-11-10T12:00:00.000Z'), end: new Date('2026-11-10T13:00:00.000Z'), stepSeconds: 60 };

    const series = await store.series(STAGING, window);

    expect(series.cpu).toEqual({
      points: [
        { at: new Date(1_762_777_200_000), value: 1.5 },
        { at: new Date(1_762_777_320_000), value: 2 },
      ],
      dailyHigh: 1.75,
    });
    // A percentile of no requests isn't a number, so there's no daily high.
    expect(series.responseTime.dailyHigh).toBeNull();
    const range = formOf(prometheus.requests.find((recorded) => recorded.path === '/api/v1/query_range')!);
    expect(range.get('query')).toContain(`{dreamdevops_place_id="${STAGING}"}[120s]`);
    expect([range.get('start'), range.get('end'), range.get('step')]).toEqual(['1794312000', '1794315600', '60']);
  });

  it('reads the daily high from the day before the window, as the chart’s points are read', async () => {
    prometheus.on('POST', '/api/v1/query_range', { body: { status: 'success', data: { resultType: 'matrix', result: [] } } });
    prometheus.on('POST', '/api/v1/query', { body: vector({}) });
    const window = { start: new Date('2026-11-10T12:00:00.000Z'), end: new Date('2026-11-10T13:00:00.000Z'), stepSeconds: 60 };

    const series = await store.series(STAGING, window);

    expect(series.memory.dailyHigh).toBeNull();
    const highs = prometheus.requests.filter((recorded) => recorded.path === '/api/v1/query').map(formOf);
    expect(highs).toHaveLength(5);
    // Evaluated where the window starts, over the 24 hours before it, once a minute.
    expect(highs.every((form) => form.get('time') === '1794312000')).toBe(true);
    expect(highs[0]!.get('query')).toBe(
      `max_over_time((max by (dreamdevops_place_id) (rate(process_cpu_time_seconds_total{dreamdevops_place_id="${STAGING}"}[120s])) * 100)[86400s:60s])`,
    );
  });

  it('works rates out over at least a step, so long ranges miss nothing between points', async () => {
    prometheus.on('POST', '/api/v1/query_range', { body: { status: 'success', data: { resultType: 'matrix', result: [] } } });
    prometheus.on('POST', '/api/v1/query', { body: vector({}) });
    const window = { start: new Date('2026-11-09T13:00:00.000Z'), end: new Date('2026-11-10T13:00:00.000Z'), stepSeconds: 1440 };

    const series = await store.series(STAGING, window);

    expect(series.requests).toEqual({ points: [], dailyHigh: null });
    const rates = queries().filter((query) => query.includes('rate('));
    expect(rates).toHaveLength(8);
    expect(rates.every((query) => query.includes('[1440s]'))).toBe(true);
    // The daily high is sampled once a step too, as the chart's points are.
    expect(queries().filter((query) => query.startsWith('max_over_time'))[0]).toMatch(/\[86400s:1440s\]\)$/);
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
    await expect(store.latest(['x"} or vector(1) #'])).rejects.toThrow("isn't a place ID");
    await expect(
      store.series('.*', { start: new Date(0), end: new Date(60_000), stepSeconds: 15 }),
    ).rejects.toThrow("isn't a place ID");
    expect(prometheus.requests).toEqual([]);
  });
});


describe('what runs, as places', () => {
  it('reads Kubernetes CPU and memory quantities', () => {
    expect(cpuCores('250m')).toBe(0.25);
    expect(cpuCores('1')).toBe(1);
    expect(cpuCores('lots')).toBeNull();
    expect(bytes('256Mi')).toBe(256 * 1024 * 1024);
    expect(bytes('1Gi')).toBe(1024 ** 3);
    expect(bytes('512M')).toBe(512_000_000);
    expect(bytes('a lot')).toBeNull();
  });
});

describe('the Loki log store', () => {
  const loki = new HttpStub();
  const PLACE = '0b5f8a2c-1d3e-8f5a-8b9c-0d1e2f3a4b5c';

  beforeAll(async () => {
    await loki.start();
  });

  afterAll(async () => {
    await loki.stop();
  });

  it('reads one place’s latest lines, oldest first, with which output each came from', async () => {
    loki.reset();
    loki.on('GET', /^\/loki\/api\/v1\/query_range\?/, () => ({
      body: {
        status: 'success',
        data: {
          result: [
            { stream: { [PLACE_LOG_LABEL]: PLACE, log_iostream: 'stderr' }, values: [['1762778096000000000', 'boom']] },
            { stream: { [PLACE_LOG_LABEL]: PLACE }, values: [['1762778097000000000', 'later'], ['1762778095000000000', 'first']] },
          ],
        },
      },
    }));
    const store = new LokiLogStore({ url: loki.url });

    const lines = await store.recent(PLACE, { since: new Date('2025-11-10T12:00:00Z'), limit: 2 });

    expect(lines.map((line) => [line.text, line.stream])).toEqual([
      ['boom', 'stderr'],
      ['later', 'stdout'],
    ]);
    const asked = new URL(loki.requests[0]!.path, 'http://loki.test');
    expect(asked.searchParams.get('query')).toBe(`{dreamdevops_place_id="${PLACE}"}`);
    expect(asked.searchParams.get('direction')).toBe('backward');
  });

  it('says when Loki can’t answer, and never puts anything but a place ID into a query', async () => {
    loki.reset();
    loki.on('GET', /^\/loki\//, () => ({ status: 500, body: { status: 'error' } }));
    const store = new LokiLogStore({ url: loki.url });

    await expect(store.recent(PLACE, { since: NOW, limit: 10 })).rejects.toThrow('The log store couldn’t answer (HTTP 500)');
    await expect(store.recent('"} or {', { since: NOW, limit: 10 })).rejects.toThrow("isn't a place ID");
    await expect(new LokiLogStore({ url: 'http://127.0.0.1:1' }).recent(PLACE, { since: NOW, limit: 10 })).rejects.toThrow(
      'The log store can’t be reached right now.',
    );
  });
});

function formOf(recorded: RecordedRequest): URLSearchParams {
  return new URLSearchParams(typeof recorded.body === 'string' ? recorded.body : '');
}
