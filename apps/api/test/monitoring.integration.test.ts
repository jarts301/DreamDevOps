import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createEnvironment,
  type Deployment,
  deployed,
  developmentImage,
  finished,
  local,
  resetHosts,
  setUp,
  startDeploymentWorldWith,
  stopDeploymentWorld,
  type World,
} from './support/deployments.ts';
import { HttpStub, type RecordedRequest } from './support/http-stub.ts';

// Applications send their metrics to Prometheus, and the API reads them back. Here a stub
// stands in for Prometheus, and answers for whichever environments a query names.
const prometheus = new HttpStub();
const METRICS_ENDPOINT = 'http://metrics.test:9090/api/v1/otlp/v1/metrics';
// Traces go to Jaeger, which a stub stands in for too. It answers with what `jaegerTraces` holds.
const jaeger = new HttpStub();
const TRACES_ENDPOINT = 'http://traces.test:4318/v1/traces';
let jaegerTraces: object[] = [];

/** Which metric each query is about, and the value the stub answers with. */
const VALUES: readonly [string, string][] = [
  ['process_cpu_time_seconds_total', '12.5'],
  ['process_memory_usage_bytes', '52428800'],
  ['histogram_quantile', '0.08'],
  ['5..', '0'],
  ['http_server_request_duration_seconds_count', '3'],
];

const queryOf = (recorded: RecordedRequest) =>
  new URLSearchParams(typeof recorded.body === 'string' ? recorded.body : '').get('query') ?? '';
const environmentsIn = (query: string) => /dreamdevops_environment_id=~?"([^"]+)"/.exec(query)?.[1]!.split('|') ?? [];
const valueFor = (query: string) => VALUES.find(([name]) => query.includes(name))![1];

beforeAll(async () => {
  await prometheus.start();
  prometheus.on('POST', '/api/v1/query', (recorded) => {
    const query = queryOf(recorded);
    return {
      body: {
        status: 'success',
        data: {
          resultType: 'vector',
          result: environmentsIn(query).map((id) => ({
            metric: { dreamdevops_environment_id: id },
            value: [Date.now() / 1000, valueFor(query)],
          })),
        },
      },
    };
  });
  prometheus.on('POST', '/api/v1/query_range', (recorded) => {
    const query = queryOf(recorded);
    const form = new URLSearchParams(recorded.body as string);
    const end = Number(form.get('end'));
    return {
      body: {
        status: 'success',
        data: {
          resultType: 'matrix',
          result: environmentsIn(query).map((id) => ({
            metric: { dreamdevops_environment_id: id },
            values: [
              [end - 15, valueFor(query)],
              [end, valueFor(query)],
            ],
          })),
        },
      },
    };
  });
  await jaeger.start();
  jaeger.on('GET', /^\/api\/traces\?/, () => ({ body: { data: jaegerTraces } }));
  jaeger.on('GET', /^\/api\/traces\/[0-9a-f]+$/, (recorded) => {
    const found = jaegerTraces.filter((trace) => recorded.path.endsWith((trace as { traceID: string }).traceID));
    return found.length === 0 ? { status: 404, body: { data: null } } : { body: { data: found } };
  });
  await startDeploymentWorldWith({
    prometheusUrl: prometheus.url,
    appMetricsEndpoint: METRICS_ENDPOINT,
    jaegerUrl: jaeger.url,
    appTracesEndpoint: TRACES_ENDPOINT,
  });
}, 180_000);

afterAll(async () => {
  await stopDeploymentWorld();
  await prometheus.stop();
  await jaeger.stop();
});

beforeEach(() => {
  resetHosts();
  prometheus.requests.length = 0;
  jaeger.requests.length = 0;
  jaegerTraces = [];
});

/** A trace as Jaeger gives it, with one span from an environment. */
const jaegerTrace = (traceId: string, service: string, environmentId: string) => ({
  traceID: traceId,
  spans: [
    {
      traceID: traceId,
      spanID: '00f067aa0ba902b7',
      operationName: 'GET',
      references: [],
      startTime: (Date.now() - 60_000) * 1000,
      duration: 4_000,
      tags: [
        { key: 'span.kind', type: 'string', value: 'server' },
        { key: 'url.path', type: 'string', value: '/api/ping' },
      ],
      processID: 'p1',
    },
  ],
  processes: { p1: { serviceName: service, tags: [{ key: 'dreamdevops.environment.id', type: 'string', value: environmentId }] } },
});

const applicationName = async (world: World) =>
  ((await world.viewer.get(`/api/v1/company/applications/${world.applicationId}`).expect(200)).body as { name: string }).name;

describe('a running application', () => {
  it('is told where to send its metrics and traces, and which environment and service it is, keeping attributes of its own', async () => {
    const world = await setUp();
    const image = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    await world.techLead
      .post(`/api/v1/company/environments/${staging.id}/variables`)
      .send({ name: 'OTEL_RESOURCE_ATTRIBUTES', value: 'team=billing' })
      .expect(201);

    expect((await deployed(world.developer, staging.id, { buildId: image.id })).status).toBe('succeeded');

    expect(local.environmentOf(staging.target!.id)).toMatchObject({
      OTEL_SERVICE_NAME: world.name,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: TRACES_ENDPOINT,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: METRICS_ENDPOINT,
      OTEL_METRIC_EXPORT_INTERVAL: '15000',
      OTEL_RESOURCE_ATTRIBUTES: `team=billing,dreamdevops.environment.id=${staging.id}`,
    });
  });
});

describe('monitoring', () => {
  it('lists the company’s running environments with their latest metrics, and asks only about those', async () => {
    const [ours, theirs] = await Promise.all([setUp(), setUp()]);
    const [ourImage, theirImage] = await Promise.all([developmentImage(ours), developmentImage(theirs)]);
    const staging = await createEnvironment(ours, ours.techLead, { name: 'Staging' });
    await createEnvironment(ours, ours.techLead, { name: 'Demo' });
    const theirStaging = await createEnvironment(theirs, theirs.techLead, { name: 'Staging' });
    await deployed(ours.developer, staging.id, { buildId: ourImage.id });
    await deployed(theirs.developer, theirStaging.id, { buildId: theirImage.id });
    prometheus.requests.length = 0;

    const { body } = await ours.viewer.get('/api/v1/company/monitoring/environments').expect(200);

    expect(body.enabled).toBe(true);
    expect(body.problem).toBeNull();
    // Demo runs nothing, so it isn't listed.
    expect(body.environments).toEqual([
      {
        environmentId: staging.id,
        environmentName: 'Staging',
        applicationId: ours.applicationId,
        applicationName: await applicationName(ours),
        production: false,
        version: ourImage.version,
        since: expect.any(String),
        address: expect.stringMatching(/^http:\/\/localhost:\d+$/),
        targetName: 'This machine',
        // What its container started with, as its deployment recorded it.
        limits: { cpus: 1, memoryBytes: 536_870_912 },
        latest: { cpu: 12.5, memory: 52_428_800, requests: 3, responseTime: 0.08, errors: 0 },
      },
    ]);
    expect(prometheus.requests).toHaveLength(5);
    for (const recorded of prometheus.requests) {
      expect(environmentsIn(queryOf(recorded))).toEqual([staging.id]);
    }
  });

  it('charts one environment over time, and never another company’s', async () => {
    const [ours, theirs] = await Promise.all([setUp(), setUp()]);
    const image = await developmentImage(ours);
    const staging = await createEnvironment(ours, ours.techLead, { name: 'Staging' });
    await deployed(ours.developer, staging.id, { buildId: image.id });

    const { body } = await ours.developer.get(`/api/v1/company/monitoring/environments/${staging.id}?range=15m`).expect(200);

    expect(body.environment).toMatchObject({
      environmentId: staging.id,
      version: image.version,
      limits: { cpus: 1, memoryBytes: 536_870_912 },
    });
    expect(body.range).toMatchObject({ key: '15m', stepSeconds: 15 });
    expect(body.series.map((series: { key: string; points: unknown[] }) => [series.key, series.points.length])).toEqual([
      ['cpu', 2],
      ['memory', 2],
      ['requests', 2],
      ['responseTime', 2],
      ['errors', 2],
    ]);
    expect(body.series[0].points[1]).toEqual({ at: body.range.end, value: 12.5 });
    // Each metric's highest value in the day before the range, for the chart's orange line.
    expect(body.series.map((series: { dailyHigh: number | null }) => series.dailyHigh)).toEqual([12.5, 52_428_800, 3, 0.08, 0]);
    expect(Date.parse(body.dailyHigh.end)).toBe(Date.parse(body.range.start));
    expect(Date.parse(body.dailyHigh.end) - Date.parse(body.dailyHigh.start)).toBe(24 * 60 * 60 * 1000);

    prometheus.requests.length = 0;
    const { body: refused } = await theirs.viewer.get(`/api/v1/company/monitoring/environments/${staging.id}`).expect(404);
    expect(refused.detail).toBe('There’s no such environment.');
    expect(prometheus.requests).toEqual([]);
  });

  it('stops listing an environment once what ran in it is stopped', async () => {
    const world = await setUp();
    const image = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    await deployed(world.developer, staging.id, { buildId: image.id });

    const { body: queued } = await world.developer.post(`/api/v1/company/environments/${staging.id}/stop`).send({}).expect(202);
    expect((await finished(world.developer, (queued as Deployment).id)).status).toBe('succeeded');

    const { body } = await world.viewer.get('/api/v1/company/monitoring/environments').expect(200);
    expect(body.environments).toEqual([]);
  });
});

describe('logs', () => {
  it('are what the running version writes, read only for the company’s own environments', async () => {
    const [ours, theirs] = await Promise.all([setUp(), setUp()]);
    const image = await developmentImage(ours);
    const staging = await createEnvironment(ours, ours.techLead, { name: 'Staging' });
    await deployed(ours.developer, staging.id, { buildId: image.id });
    const now = Date.now();
    local.write(staging.target!.id, { at: new Date(now - 2 * 60 * 60_000), stream: 'stdout', text: 'two hours ago' });
    local.write(staging.target!.id, {
      at: new Date(now - 60_000),
      stream: 'stdout',
      text: '{"level":30,"msg":"Ping received","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736"}',
    });

    const { body } = await ours.viewer.get(`/api/v1/company/monitoring/environments/${staging.id}/logs?range=1h`).expect(200);

    expect(body.running).toBe(true);
    expect(body.lines).toEqual([
      {
        at: new Date(now - 60_000).toISOString(),
        stream: 'stdout',
        level: 'info',
        message: 'Ping received',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: null,
      },
    ]);
    expect(local.logReads.at(-1)).toMatchObject({ name: expect.stringContaining(ours.name), limit: 500 });
    const { body: refused } = await theirs.viewer.get(`/api/v1/company/monitoring/environments/${staging.id}/logs`).expect(404);
    expect(refused.detail).toBe('There’s no such environment.');
  });

  it('are none once what ran is stopped', async () => {
    const world = await setUp();
    const image = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    await deployed(world.developer, staging.id, { buildId: image.id });
    local.write(staging.target!.id, { at: new Date(), stream: 'stdout', text: 'still here' });
    const { body: queued } = await world.developer.post(`/api/v1/company/environments/${staging.id}/stop`).send({}).expect(202);
    await finished(world.developer, (queued as Deployment).id);

    const { body } = await world.viewer.get(`/api/v1/company/monitoring/environments/${staging.id}/logs`).expect(200);

    expect([body.running, body.lines]).toEqual([false, []]);
  });
});

describe('traces', () => {
  it('are found by the application’s short name, and shown only with the company’s own spans', async () => {
    const [ours, theirs] = await Promise.all([setUp(), setUp()]);
    const image = await developmentImage(ours);
    const staging = await createEnvironment(ours, ours.techLead, { name: 'Staging' });
    await deployed(ours.developer, staging.id, { buildId: image.id });
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    jaegerTraces = [jaegerTrace(traceId, ours.name, staging.id)];

    const { body } = await ours.viewer.get(`/api/v1/company/monitoring/environments/${staging.id}/traces`).expect(200);

    expect(body).toMatchObject({ enabled: true, serviceName: ours.name, traces: [{ traceId, name: 'GET', spans: 1, errors: 0 }] });
    expect(jaeger.calls()[0]).toMatch(new RegExp(`^GET /api/traces\\?service=${ours.name}&start=\\d+&end=\\d+&limit=100$`));

    const { body: trace } = await ours.developer.get(`/api/v1/company/monitoring/traces/${traceId}`).expect(200);
    expect(trace.spans).toEqual([
      expect.objectContaining({
        name: 'GET',
        environmentId: staging.id,
        environmentName: 'Staging',
        applicationName: await applicationName(ours),
        attributes: { 'url.path': '/api/ping' },
      }),
    ]);
    await theirs.viewer.get(`/api/v1/company/monitoring/traces/${traceId}`).expect(404);
  });
});
