import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApplicationCatalog } from '../src/catalog/application/application-catalog.ts';
import { Entitlements } from '../src/editions/application/entitlements.ts';
import { ENVIRONMENT_LOGS, LogsUnavailableError } from '../src/environments/application/environment-logs.ts';
import { RUNNING_ENVIRONMENTS, type RunningEnvironment } from '../src/environments/application/running-environments.ts';
import { ApplicationLogs } from '../src/monitoring/application/application-logs.ts';
import { ApplicationTraces } from '../src/monitoring/application/application-traces.ts';
import { TRACE_STORE, TracesUnavailableError } from '../src/monitoring/application/ports.ts';
import { parseLogLine } from '../src/monitoring/domain/logs.ts';
import { parseTraceId, type StoredSpan, summarize } from '../src/monitoring/domain/traces.ts';
import { JaegerTraceStore } from '../src/monitoring/infrastructure/jaeger-trace-store.ts';
import {
  COMPANY_A,
  COMPANY_B,
  FakeApplicationCatalog,
  FakeEnvironmentLogs,
  FakeRunningEnvironments,
  FakeTraceStore,
} from './fakes.ts';
import { HttpStub } from './support/http-stub.ts';
import { signIn as signInAs } from './support/integration.ts';
import { createTestApp } from './test-app.ts';

const BILLING = '00000000-0000-4000-8000-0000000000a1';
const WEBSITE = '00000000-0000-4000-8000-0000000000a2';
const THEIR_BILLING = '00000000-0000-4000-8000-0000000000b1';
const STAGING = '00000000-0000-4000-8000-0000000000e1';
const WEBSITE_STAGING = '00000000-0000-4000-8000-0000000000e3';
const IDLE = '00000000-0000-4000-8000-0000000000e4';
const THEIRS = '00000000-0000-4000-8000-0000000000f1';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const OTHER_TRACE = '0af7651916cd43dd8448eb211c80319c';

const inCompany = <T>(companyId: string, work: () => Promise<T>) => runWithCompany(parseCompanyId(companyId), work);

const running = (overrides: Partial<RunningEnvironment>): RunningEnvironment => ({
  environmentId: STAGING,
  environmentName: 'Staging',
  applicationId: BILLING,
  production: false,
  version: '1.4.0',
  since: '2026-11-10T09:00:00.000Z',
  address: 'http://localhost:49153',
  targetName: 'This machine',
  limits: { cpus: 1, memoryBytes: 512 * 1024 * 1024 },
  ...overrides,
});

const span = (overrides: Partial<StoredSpan>): StoredSpan => ({
  spanId: '00f067aa0ba902b7',
  parentSpanId: null,
  name: 'GET',
  serviceName: 'billing-api',
  environmentId: STAGING,
  start: new Date('2026-11-10T11:59:00.000Z'),
  durationMs: 12,
  kind: 'server',
  error: false,
  attributes: { 'http.request.method': 'GET', 'url.path': '/api/ping', 'http.response.status_code': 200 },
  ...overrides,
});

/**
 * Company A runs a billing API and a website, and has an idle environment. Company B runs a
 * service of the same name, billing-api, and its website called A's billing API in one trace.
 */
function world() {
  const environments = new FakeRunningEnvironments();
  environments.byCompany.set(COMPANY_A, [
    running({}),
    running({ environmentId: WEBSITE_STAGING, applicationId: WEBSITE, version: '2.0.0' }),
    running({ environmentId: IDLE, environmentName: 'Demo', version: null }),
  ]);
  environments.byCompany.set(COMPANY_B, [running({ environmentId: THEIRS, applicationId: THEIR_BILLING })]);
  const catalog = new FakeApplicationCatalog();
  catalog.byCompany.set(COMPANY_A, [
    { id: BILLING, name: 'Billing API', status: 'active' },
    { id: WEBSITE, name: 'Website', status: 'active' },
  ]);
  catalog.byCompany.set(COMPANY_B, [{ id: THEIR_BILLING, name: 'Billing API', status: 'active' }]);
  const logs = new FakeEnvironmentLogs(environments);
  const traces = new FakeTraceStore();
  traces.traces.push(
    {
      traceId: TRACE,
      spans: [
        span({ spanId: 'a000000000000001', name: 'GET /', serviceName: 'website', environmentId: WEBSITE_STAGING, durationMs: 40 }),
        span({
          spanId: 'a000000000000002',
          parentSpanId: 'a000000000000001',
          start: new Date('2026-11-10T11:59:00.010Z'),
          error: true,
        }),
        // Company B's service, which this request passed through.
        span({
          spanId: 'b000000000000001',
          parentSpanId: 'a000000000000002',
          environmentId: THEIRS,
          start: new Date('2026-11-10T11:59:00.015Z'),
          durationMs: 3,
        }),
      ],
    },
    { traceId: OTHER_TRACE, spans: [span({ spanId: 'b000000000000002', environmentId: THEIRS })] },
  );
  return { environments, catalog, logs, traces };
}

const logsOf = (setup: ReturnType<typeof world>) => new ApplicationLogs(setup.environments, setup.logs, () => NOW);
const tracesOf = (setup: ReturnType<typeof world>, options: { store?: boolean } = {}) =>
  new ApplicationTraces(
    setup.environments,
    setup.catalog as unknown as ApplicationCatalog,
    options.store === false ? null : setup.traces,
    () => NOW,
  );

describe('log lines', () => {
  const at = new Date('2026-11-10T12:00:00.000Z');
  const line = (text: string, stream: 'stdout' | 'stderr' = 'stdout') => parseLogLine({ at, stream, text });

  it('give the level, message and trace of JSON lines, such as Fastify writes', () => {
    expect(
      line(
        JSON.stringify({
          level: 30,
          time: 1_794_312_000_000,
          msg: 'Ping received',
          trace_id: '4BF92F3577B34DA6A3CE929D0E0E4736',
          span_id: '00f067aa0ba902b7',
        }),
      ),
    ).toEqual({
      at: '2026-11-10T12:00:00.000Z',
      stream: 'stdout',
      level: 'info',
      message: 'Ping received',
      traceId: TRACE,
      spanId: '00f067aa0ba902b7',
    });
  });

  it('say which request a framework logged about', () => {
    expect(line('{"level":30,"msg":"incoming request","req":{"method":"GET","url":"/api/ping"}}').message).toBe(
      'incoming request: GET /api/ping',
    );
    expect(line('{"level":30,"msg":"request completed","res":{"statusCode":200},"responseTime":2.6}').message).toBe(
      'request completed: 200 in 3 ms',
    );
  });

  it('take the trace from a traceparent, as nginx logs it', () => {
    const parsed = line(
      '{"level":"info","msg":"GET / 200","traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}',
    );

    expect([parsed.level, parsed.message, parsed.traceId, parsed.spanId]).toEqual(['info', 'GET / 200', TRACE, '00f067aa0ba902b7']);
  });

  it('know the usual names and numbers of levels', () => {
    expect(['trace', 'DEBUG', 'notice', 'warning', 'err', 'critical'].map((level) => line(`{"level":"${level}","msg":"x"}`).level)).toEqual([
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
    ]);
    expect([10, 20, 40, 50, 60].map((level) => line(`{"level":${level},"msg":"x"}`).level)).toEqual([
      'trace',
      'debug',
      'warn',
      'error',
      'fatal',
    ]);
    expect(line('{"level":"loud","msg":"x"}').level).toBeNull();
  });

  it('show any other line as it is', () => {
    expect(line('2026/11/10 12:00:00 [notice] 1#1: start worker processes', 'stderr')).toEqual({
      at: '2026-11-10T12:00:00.000Z',
      stream: 'stderr',
      level: null,
      message: '2026/11/10 12:00:00 [notice] 1#1: start worker processes',
      traceId: null,
      spanId: null,
    });
    expect(line('{"not":"a message"}').message).toBe('{"not":"a message"}');
    expect(line('{broken json').message).toBe('{broken json');
    expect(line('[1, 2]').level).toBeNull();
  });

  it('ignore trace IDs that aren’t W3C ones', () => {
    expect(line('{"msg":"x","trace_id":"not-an-id","span_id":"00f067aa0ba902b7"}')).toMatchObject({ traceId: null, spanId: null });
    expect(line('{"msg":"x","trace_id":"00000000000000000000000000000000"}').traceId).toBeNull();
  });
});

describe('traces', () => {
  it('are named by 32 hexadecimal digits', () => {
    expect(parseTraceId('4BF92F3577B34DA6A3CE929D0E0E4736')).toBe(TRACE);
    for (const value of ['00000000000000000000000000000000', '4bf92f3577b34da6', 'x'.repeat(32), undefined]) {
      expect(() => parseTraceId(value)).toThrow('A trace ID is 32 hexadecimal digits.');
    }
  });

  it('are summed up by their first span, their whole length, and what failed', () => {
    const summary = summarize(TRACE, world().traces.traces[0]!.spans);

    expect(summary).toEqual({
      traceId: TRACE,
      name: 'GET /',
      start: '2026-11-10T11:59:00.000Z',
      durationMs: 40,
      spans: 3,
      errors: 1,
      services: ['billing-api', 'website'],
    });
  });
});

describe('the logs of a running application', () => {
  it('are read for the range chosen, with each line’s level, message and trace', async () => {
    const setup = world();
    setup.logs.written.set(STAGING, [
      { at: new Date('2026-11-10T10:00:00.000Z'), stream: 'stdout', text: 'too old for the last hour' },
      { at: new Date('2026-11-10T11:30:00.000Z'), stream: 'stdout', text: `{"level":30,"msg":"Ping received","trace_id":"${TRACE}"}` },
      { at: new Date('2026-11-10T11:31:00.000Z'), stream: 'stderr', text: 'plain' },
    ]);

    const view = await inCompany(COMPANY_A, () => logsOf(setup).read(STAGING, '1h'));

    expect(view).toEqual({
      environmentId: STAGING,
      running: true,
      range: { key: '1h', start: '2026-11-10T11:00:00.000Z', end: '2026-11-10T12:00:00.000Z' },
      lines: [
        { at: '2026-11-10T11:30:00.000Z', stream: 'stdout', level: 'info', message: 'Ping received', traceId: TRACE, spanId: null },
        { at: '2026-11-10T11:31:00.000Z', stream: 'stderr', level: null, message: 'plain', traceId: null, spanId: null },
      ],
    });
    expect(setup.logs.reads).toEqual([{ environmentId: STAGING, since: new Date('2026-11-10T11:00:00.000Z'), limit: 500 }]);
  });

  it('are none where nothing runs', async () => {
    const view = await inCompany(COMPANY_A, () => logsOf(world()).read(IDLE, '15m'));

    expect([view.running, view.lines]).toEqual([false, []]);
  });

  it('are never read from another company’s environment', async () => {
    const setup = world();

    await expect(inCompany(COMPANY_A, () => logsOf(setup).read(THEIRS, '1h'))).rejects.toMatchObject({
      kind: 'not-found',
      message: 'There’s no such environment.',
    });
    expect(setup.logs.reads).toEqual([]);
  });

  it('say why when the host can’t give them, and refuse a range it doesn’t offer', async () => {
    const setup = world();
    setup.logs.failure = new LogsUnavailableError('The logs can’t be read from This machine right now. Docker isn’t running.');

    await expect(inCompany(COMPANY_A, () => logsOf(setup).read(STAGING, '1h'))).rejects.toMatchObject({
      kind: 'unavailable',
      message: 'The logs can’t be read from This machine right now. Docker isn’t running.',
    });
    await expect(inCompany(COMPANY_A, () => logsOf(setup).read(STAGING, '7d'))).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('the traces of a running application', () => {
  it('list the latest an environment took part in, by its own spans, found by the application’s short name', async () => {
    const setup = world();

    const found = await inCompany(COMPANY_A, () => tracesOf(setup).recent(STAGING, '1h'));

    expect(found).toEqual({
      enabled: true,
      serviceName: 'billing-api',
      range: { key: '1h', start: '2026-11-10T11:00:00.000Z', end: '2026-11-10T12:00:00.000Z' },
      traces: [
        {
          traceId: TRACE,
          name: 'GET',
          start: '2026-11-10T11:59:00.010Z',
          durationMs: 12,
          spans: 1,
          errors: 1,
          services: ['billing-api'],
        },
      ],
    });
    expect(setup.traces.searches).toEqual([
      { serviceName: 'billing-api', start: new Date('2026-11-10T11:00:00.000Z'), end: NOW, limit: 100 },
    ]);
  });

  it('count only the company’s own spans, even in traces that passed through another company', async () => {
    const setup = world();

    const found = await inCompany(COMPANY_B, () => tracesOf(setup).recent(THEIRS, '1h'));

    // B's service has the same name as A's, and B sees only its own span of each trace.
    expect(found.traces.map((trace) => [trace.traceId, trace.spans, trace.services])).toEqual([
      [TRACE, 1, ['billing-api']],
      [OTHER_TRACE, 1, ['billing-api']],
    ]);
  });

  it('say when the server keeps no traces, without asking anything', async () => {
    const setup = world();

    const found = await inCompany(COMPANY_A, () => tracesOf(setup, { store: false }).recent(STAGING, '1h'));

    expect([found.enabled, found.traces]).toEqual([false, []]);
    expect(setup.traces.searches).toEqual([]);
  });

  it('show one trace with the company’s own spans only, across its applications, and how many others it left out', async () => {
    const view = await inCompany(COMPANY_A, () => tracesOf(world()).trace(TRACE.toUpperCase()));

    expect(view.traceId).toBe(TRACE);
    expect(view.hiddenSpans).toBe(1);
    expect(view.durationMs).toBe(40);
    expect(view.spans.map((shown) => [shown.name, shown.applicationName, shown.environmentName, shown.offsetMs, shown.error])).toEqual([
      ['GET /', 'Website', 'Staging', 0, false],
      ['GET', 'Billing API', 'Staging', 10, true],
    ]);
    expect(view.spans[1]).toMatchObject({
      spanId: 'a000000000000002',
      parentSpanId: 'a000000000000001',
      serviceName: 'billing-api',
      environmentId: STAGING,
      production: false,
      kind: 'server',
      attributes: { 'url.path': '/api/ping' },
    });
  });

  it('never show a trace that holds none of the company’s spans', async () => {
    const setup = world();

    await expect(inCompany(COMPANY_A, () => tracesOf(setup).trace(OTHER_TRACE))).rejects.toMatchObject({ kind: 'not-found' });
    await expect(inCompany(COMPANY_A, () => tracesOf(setup).trace('ffffffffffffffffffffffffffffffff'))).rejects.toMatchObject({
      kind: 'not-found',
      message: 'There’s no such trace, or none of it comes from your applications.',
    });
    // Company B sees its part of the trace that passed through it, and nothing of A's.
    const theirs = await inCompany(COMPANY_B, () => tracesOf(setup).trace(TRACE));
    expect([theirs.spans.map((shown) => shown.spanId), theirs.hiddenSpans]).toEqual([['b000000000000001'], 2]);
  });

  it('explain when traces aren’t kept or can’t be read, and refuse an ID that isn’t one', async () => {
    const setup = world();
    await expect(inCompany(COMPANY_A, () => tracesOf(setup, { store: false }).trace(TRACE))).rejects.toMatchObject({
      kind: 'unavailable',
      message: 'This server doesn’t keep applications’ traces. An administrator can set it up with JAEGER_URL.',
    });
    setup.traces.failure = new TracesUnavailableError('The trace store can’t be reached right now. Try again shortly.');
    await expect(inCompany(COMPANY_A, () => tracesOf(setup).trace(TRACE))).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(inCompany(COMPANY_A, () => tracesOf(setup).trace('nope'))).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('the Jaeger trace store', () => {
  const jaeger = new HttpStub();
  let store: JaegerTraceStore;

  /** A trace as Jaeger's query API gives it, with IDs it shortened by their leading zeros. */
  const answer = {
    data: [
      {
        traceID: 'af7651916cd43dd8448eb211c80319c',
        spans: [
          {
            traceID: 'af7651916cd43dd8448eb211c80319c',
            spanID: 'b7ad6b7169203331',
            operationName: 'GET',
            references: [{ refType: 'CHILD_OF', traceID: 'af7651916cd43dd8448eb211c80319c', spanID: 'ad6b7169203331' }],
            startTime: 1_794_311_940_000_000,
            duration: 12_500,
            tags: [
              { key: 'span.kind', type: 'string', value: 'server' },
              { key: 'otel.status_code', type: 'string', value: 'ERROR' },
              { key: 'http.request.method', type: 'string', value: 'GET' },
              { key: 'http.response.status_code', type: 'int64', value: 500 },
              { key: 'url.path', type: 'string', value: `/api/${'x'.repeat(400)}` },
            ],
            processID: 'p1',
          },
          {
            traceID: 'af7651916cd43dd8448eb211c80319c',
            spanID: '00f067aa0ba902b7',
            operationName: '',
            references: [],
            startTime: 1_794_311_939_990_000,
            duration: 30_000,
            tags: null,
            processID: 'p2',
          },
        ],
        processes: {
          p1: { serviceName: 'billing-api', tags: [{ key: 'dreamdevops.environment.id', type: 'string', value: STAGING.toUpperCase() }] },
          p2: { serviceName: 'website', tags: [] },
        },
      },
    ],
  };

  beforeAll(async () => {
    await jaeger.start();
  });

  beforeEach(() => {
    jaeger.reset();
    store = new JaegerTraceStore({ url: `${jaeger.url}/`, timeoutMs: 2_000 });
  });

  afterAll(async () => {
    await jaeger.stop();
  });

  it('finds a service’s traces in a window, newest first, with each span’s environment, parent and outcome', async () => {
    jaeger.on('GET', /^\/api\/traces\?/, { body: answer });

    const [trace] = await store.recent(
      'billing-api',
      { start: new Date('2026-11-10T11:00:00.000Z'), end: new Date('2026-11-10T12:00:00.000Z') },
      100,
    );

    expect(jaeger.calls()).toEqual([`GET /api/traces?service=billing-api&start=1794308400000000&end=1794312000000000&limit=100`]);
    expect(trace!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(trace!.spans[0]).toEqual({
      spanId: 'b7ad6b7169203331',
      parentSpanId: '00ad6b7169203331',
      name: 'GET',
      serviceName: 'billing-api',
      environmentId: STAGING,
      start: new Date(1_794_311_940_000),
      durationMs: 12.5,
      kind: 'server',
      error: true,
      attributes: { 'http.request.method': 'GET', 'http.response.status_code': 500, 'url.path': `/api/${'x'.repeat(295)}` },
    });
    expect(trace!.spans[1]).toMatchObject({
      parentSpanId: null,
      name: 'Unnamed',
      serviceName: 'website',
      environmentId: null,
      kind: null,
      error: false,
      attributes: {},
    });
  });

  it('reads one trace by its ID, and says when it has none', async () => {
    jaeger.on('GET', '/api/traces/0af7651916cd43dd8448eb211c80319c', { body: answer });
    jaeger.on('GET', `/api/traces/${TRACE}`, { status: 404, body: { data: null, errors: [{ code: 404, msg: 'trace not found' }] } });

    expect((await store.find(OTHER_TRACE))?.spans).toHaveLength(2);
    expect(await store.find(TRACE)).toBeNull();
    expect(await store.find('../api/services')).toBeNull();
    expect(jaeger.calls()).toHaveLength(2);
  });

  it('says when Jaeger can’t be reached or can’t answer', async () => {
    jaeger.on('GET', /^\/api\/traces/, { status: 503, body: {} });
    await expect(store.find(TRACE)).rejects.toThrow(
      new TracesUnavailableError('The trace store couldn’t answer (HTTP 503). Try again shortly.'),
    );

    const unreachable = new JaegerTraceStore({ url: 'http://127.0.0.1:1', timeoutMs: 2_000 });
    await expect(unreachable.find(TRACE)).rejects.toThrow(
      new TracesUnavailableError('The trace store can’t be reached right now. Try again shortly.'),
    );
  });
});

describe('log and trace routes', () => {
  let app: INestApplication;
  const setup = world();

  beforeAll(async () => {
    app = await createTestApp({
      config: { secureCookies: false },
      overrides: [
        { provide: RUNNING_ENVIRONMENTS, useValue: setup.environments },
        { provide: ApplicationCatalog, useValue: setup.catalog },
        { provide: ENVIRONMENT_LOGS, useValue: setup.logs },
        { provide: TRACE_STORE, useValue: setup.traces },
        { provide: Entitlements, useValue: { isEnabled: async () => true } },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const signIn = (user: string) => signInAs(app, user);
  const paths = [
    `/api/v1/company/monitoring/environments/${STAGING}/logs`,
    `/api/v1/company/monitoring/environments/${STAGING}/traces`,
    `/api/v1/company/monitoring/traces/${TRACE}`,
  ];

  it.each(paths)('ask anonymous users to sign in: %s', async (path) => {
    await request(app.getHttpServer()).get(path).expect(401);
  });

  it.each(paths)('refuse members who don’t view dashboards and logs: %s', async (path) => {
    await (await signIn('developer-a')).get(path).expect(403);
  });

  it('let members who view dashboards and logs read their own company’s', async () => {
    const viewer = await signIn('viewer-a');
    // The routes use the real time, so this trace happened a minute ago.
    setup.traces.traces.push({ traceId: 'c'.repeat(32), spans: [span({ start: new Date(Date.now() - 60_000) })] });

    expect((await viewer.get(`${paths[0]}?range=15m`).expect(200)).body.range.key).toBe('15m');
    expect((await viewer.get(paths[1]!).expect(200)).body.traces).toHaveLength(1);
    expect((await viewer.get(paths[2]!).expect(200)).body.spans).toHaveLength(2);
    await viewer.get(`/api/v1/company/monitoring/environments/${THEIRS}/logs`).expect(404);
    await viewer.get(`/api/v1/company/monitoring/traces/${OTHER_TRACE}`).expect(404);
    await viewer.get('/api/v1/company/monitoring/traces/not-a-trace').expect(400);
  });
});
