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
  await startDeploymentWorldWith({ prometheusUrl: prometheus.url, appMetricsEndpoint: METRICS_ENDPOINT });
}, 180_000);

afterAll(async () => {
  await stopDeploymentWorld();
  await prometheus.stop();
});

beforeEach(() => {
  resetHosts();
  prometheus.requests.length = 0;
});

const applicationName = async (world: World) =>
  ((await world.viewer.get(`/api/v1/company/applications/${world.applicationId}`).expect(200)).body as { name: string }).name;

describe('a running application', () => {
  it('is told where to send its metrics, and which environment it is, keeping attributes of its own', async () => {
    const world = await setUp();
    const image = await developmentImage(world);
    const staging = await createEnvironment(world, world.techLead, { name: 'Staging' });
    await world.techLead
      .post(`/api/v1/company/environments/${staging.id}/variables`)
      .send({ name: 'OTEL_RESOURCE_ATTRIBUTES', value: 'team=billing' })
      .expect(201);

    expect((await deployed(world.developer, staging.id, { buildId: image.id })).status).toBe('succeeded');

    expect(local.environmentOf(staging.target!.id)).toMatchObject({
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

    expect(body.environment).toMatchObject({ environmentId: staging.id, version: image.version });
    expect(body.range).toMatchObject({ key: '15m', stepSeconds: 15 });
    expect(body.series.map((series: { key: string; points: unknown[] }) => [series.key, series.points.length])).toEqual([
      ['cpu', 2],
      ['memory', 2],
      ['requests', 2],
      ['responseTime', 2],
      ['errors', 2],
    ]);
    expect(body.series[0].points[1]).toEqual({ at: body.range.end, value: 12.5 });

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
