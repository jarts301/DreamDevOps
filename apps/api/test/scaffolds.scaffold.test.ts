import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareVersions } from '../src/blueprints/domain/blueprint.ts';
import { BlueprintLibrary } from '../src/blueprints/infrastructure/blueprint-library.ts';
import { pipelineOf } from './support/pipeline.ts';

// Checks that every blueprint version produces a project that passes its own pipeline,
// run in the pipeline's own container as Forgejo runs it, builds an image, and starts
// healthy as a read-only, non-root container. It also checks the container sends its
// metrics where the platform says, and logs and traces a request, for every version that does.
// It's slow and needs Docker and the internet: npm run test:scaffolds

const BLUEPRINTS = fileURLToPath(new URL('../../../blueprints', import.meta.url));
const library = BlueprintLibrary.load(BLUEPRINTS);
const folders: string[] = [];

function run(command: string, args: string[], cwd: string): string {
  // Pipelines and builds print a lot, such as every crate Cargo compiles.
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`.slice(-4_000));
  }
  return result.stdout.trim();
}

/**
 * Runs a project's pipeline as Forgejo does: each step in turn, in a container of the
 * pipeline's image, with the project's files in it. So what's checked is the pipeline
 * itself, with the tools it installs, on any machine with Docker.
 */
function runPipeline(workflow: string, folder: string): void {
  const { image, steps } = pipelineOf(workflow);
  const container = run('docker', ['run', '-d', '--entrypoint', 'sleep', image, 'infinity'], folder);
  try {
    run('docker', ['cp', `${folder}/.`, `${container}:/app`], folder);
    for (const step of steps) {
      run('docker', ['exec', '-w', '/app', container, 'sh', '-ec', step], folder);
    }
  } finally {
    spawnSync('docker', ['rm', '-f', container]);
  }
}

async function waitForHealth(url: string): Promise<number> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.status;
      }
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} never became healthy.`);
}

/**
 * The first version of each blueprint that sends metrics when the platform says where. The
 * first blueprints gained them in 1.2.0. Blueprints made since have had them from 1.0.0.
 */
const FIRST_WITH_METRICS: Readonly<Record<string, string>> = { 'node-service': '1.2.0', 'angular-frontend': '1.2.0' };
/**
 * The first version of each blueprint that logs in JSON, with the trace a request brings,
 * and, for services, sends traces. The first blueprints gained them in 1.3.0.
 */
const FIRST_WITH_TRACES: Readonly<Record<string, string>> = { 'node-service': '1.3.0', 'angular-frontend': '1.3.0' };
/**
 * The first version of each web frontend that logs the path a browser asked for. Earlier
 * versions log nginx's $uri, which is /index.html whenever nginx serves the app's page, such
 * as for / or one of the app's routes. Published versions never change, so they still do.
 */
const FIRST_LOGGING_REQUESTED_PATH: Readonly<Record<string, string>> = {
  'angular-frontend': '1.3.1',
  'react-typescript-frontend': '1.0.1',
  'react-javascript-frontend': '1.0.1',
  'vue-typescript-frontend': '1.0.1',
  'vue-javascript-frontend': '1.0.1',
  'svelte-typescript-frontend': '1.0.1',
  'svelte-javascript-frontend': '1.0.1',
  'pyscript-frontend': '1.0.1',
};
/**
 * The first version of each service whose image holds neither npm nor Yarn, which come
 * with the base image and bring packages scanners report, nor a package.json named after
 * the application, which scanners take for the published package of that name.
 */
const FIRST_WITHOUT_NPM: Readonly<Record<string, string>> = {
  'node-service': '1.3.1',
  'express-typescript-service': '1.0.1',
  'express-javascript-service': '1.0.1',
  'fastify-javascript-service': '1.0.1',
  'nestjs-typescript-service': '1.0.1',
  'fastapi-python-service': '1.0.1',
  'flask-python-service': '1.0.1',
  'axum-rust-service': '1.0.1',
  'actix-web-rust-service': '1.0.1',
  'httplib-cpp-service': '1.0.1',
};
const since = (firsts: Readonly<Record<string, string>>, manifest: { key: string; version: string }) =>
  compareVersions(manifest.version, firsts[manifest.key] ?? '1.0.0') >= 0;

/**
 * What containers send over OTLP, as the platform's metrics and trace stores would receive
 * it: JSON, or protobuf, which OpenTelemetry's Python exporters send, as Prometheus and
 * Jaeger accept both.
 */
interface Received {
  /** Where it was sent, such as /v1/traces, which says what it holds. */
  readonly path: string;
  readonly json: unknown;
  readonly raw: Buffer;
}
const received: Received[] = [];
const metricsSink = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks);
    const json = (request.headers['content-type'] ?? '').includes('json') ? (JSON.parse(raw.toString('utf8')) as unknown) : null;
    received.push({ path: request.url ?? '', json, raw });
    // Each format is answered in its own kind, and an empty message is valid in both.
    response.writeHead(200, { 'Content-Type': json === null ? 'application/x-protobuf' : 'application/json' }).end(json === null ? '' : '{}');
  });
});

/**
 * Whether a protobuf message holds these bytes. Protobuf keeps strings, such as metrics'
 * names and attributes, and trace IDs, as they are, so they can be found without decoding.
 */
const holds = (message: Received, bytes: Buffer) => message.json === null && message.raw.includes(bytes);

/** Whether a container sent a span of this trace, within a minute. */
async function sentSpanOf(traceId: string): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // Only traces count: metrics can hold trace IDs too, in the exemplars of their histograms.
    const found = received.some((message) => {
      if (!message.path.endsWith('/traces')) {
        return false;
      }
      if (message.json === null) {
        return holds(message, Buffer.from(traceId, 'hex'));
      }
      const payload = message.json as { resourceSpans?: { scopeSpans?: { spans?: { traceId: string }[] }[] }[] };
      return (payload.resourceSpans ?? []).some((resource) =>
        (resource.scopeSpans ?? []).some((scope) => (scope.spans ?? []).some((span) => span.traceId === traceId)),
      );
    });
    if (found) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** The container's log lines that are JSON, as the platform reads them. */
function jsonLogsOf(container: string, folder: string): Record<string, unknown>[] {
  return run('docker', ['logs', container], folder)
    .split('\n')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

/** The metrics names sent with this environment's attribute, once all the expected ones arrived. */
async function metricsOf(environmentId: string, expected: readonly string[]): Promise<string[]> {
  const deadline = Date.now() + 60_000;
  let names = new Set<string>();
  while (Date.now() < deadline) {
    names = new Set(
      received.flatMap((message) => {
        if (!message.path.endsWith('/metrics')) {
          return [];
        }
        if (message.json === null) {
          // A message with this environment's attribute, and the names it holds.
          return holds(message, Buffer.from(environmentId))
            ? expected.filter((name) => holds(message, Buffer.from(name)))
            : [];
        }
        const payload = message.json as {
          resourceMetrics?: {
            resource?: { attributes?: { key: string; value: { stringValue?: string } }[] };
            scopeMetrics?: { metrics?: { name: string }[] }[];
          }[];
        };
        return (payload.resourceMetrics ?? [])
          .filter((resource) =>
            resource.resource?.attributes?.some(
              (attribute) => attribute.key === 'dreamdevops.environment.id' && attribute.value.stringValue === environmentId,
            ),
          )
          .flatMap((resource) => (resource.scopeMetrics ?? []).flatMap((scope) => (scope.metrics ?? []).map((metric) => metric.name)));
      }),
    );
    if (expected.every((name) => names.has(name))) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return [...names].sort();
}

beforeAll(async () => {
  // Containers reach this machine at host.docker.internal, which on Linux isn't 127.0.0.1.
  await new Promise<void>((resolve) => metricsSink.listen(0, '0.0.0.0', resolve));
});

afterAll(async () => {
  // Containers are removed while they may be sending metrics, which can leave a request
  // open that close() would wait for, so every connection is ended first.
  metricsSink.closeAllConnections();
  await new Promise<void>((resolve) => metricsSink.close(() => resolve()));
  // Each test removes its own project. This only catches what a failure left behind.
  for (const folder of folders) {
    rmSync(folder, { recursive: true, force: true });
  }
}, 120_000);

describe.each(library.all())('the $key $version blueprint', (manifest) => {
  it('makes a project that passes its own checks and runs as a healthy container', async () => {
    const folder = mkdtempSync(join(tmpdir(), `scaffold-${manifest.key}-`));
    folders.push(folder);
    for (const file of library.render(manifest.key, manifest.version, { name: 'Scaffold Check', slug: 'scaffold-check' })) {
      mkdirSync(dirname(join(folder, file.path)), { recursive: true });
      writeFileSync(join(folder, file.path), file.content);
    }

    runPipeline(readFileSync(join(folder, manifest.pipeline), 'utf8'), folder);

    const image = `dreamdevops-scaffold-check-${manifest.key}:${manifest.version}`;
    run('docker', ['build', '--quiet', '-t', image, '.'], folder);
    // The settings the platform gives every container, so it sends its metrics and traces.
    const environmentId = `scaffold-check-${manifest.key}-${manifest.version}`;
    const metricsPort = (metricsSink.address() as AddressInfo).port;
    const telemetry = [
      ['--add-host', 'host.docker.internal:host-gateway'],
      ['-e', `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://host.docker.internal:${metricsPort}/v1/metrics`],
      ['-e', `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://host.docker.internal:${metricsPort}/v1/traces`],
      ['-e', 'OTEL_METRIC_EXPORT_INTERVAL=1000'],
      ['-e', `OTEL_RESOURCE_ATTRIBUTES=dreamdevops.environment.id=${environmentId}`],
    ].flat();
    const container = run(
      'docker',
      ['run', '-d', '--rm', '--read-only', '--tmpfs', '/tmp', ...telemetry, '-p', `127.0.0.1::${manifest.runtime.port}`, image],
      folder,
    );
    try {
      const address = run('docker', ['port', container, String(manifest.runtime.port)], folder).split('\n')[0]!;
      const base = `http://${address}`;
      expect(await waitForHealth(`${base}${manifest.runtime.livenessPath}`)).toBe(200);
      expect((await fetch(`${base}${manifest.runtime.readinessPath}`)).status).toBe(200);
      const user = run('docker', ['exec', container, 'id', '-u'], folder);
      expect(user).not.toBe('0');

      if (manifest.applicationType === 'restful-service' && since(FIRST_WITHOUT_NPM, manifest)) {
        const found = (command: string) => spawnSync('docker', ['exec', container, 'sh', '-c', command]).status === 0;
        expect(found('command -v npm || command -v yarn || ls /usr/local/lib/node_modules')).toBe(false);
        expect(found('grep -q \'"name"\' /app/package.json')).toBe(false);
      }

      if (since(FIRST_WITH_METRICS, manifest)) {
        // A request that isn't a health check, so a service has a request to measure.
        await fetch(`${base}/`);
        const expected = ['process.cpu.time', 'process.memory.usage'];
        if (manifest.applicationType === 'restful-service') {
          expected.push('http.server.request.duration');
        }
        expect(await metricsOf(environmentId, expected)).toEqual(expect.arrayContaining(expected));
      }

      if (since(FIRST_WITH_TRACES, manifest)) {
        // A request in a trace a caller started, as another service or a web page would.
        const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
        const traceparent = `00-${traceId}-00f067aa0ba902b7-01`;
        const service = manifest.applicationType === 'restful-service';
        expect((await fetch(`${base}${service ? '/api/ping' : '/'}`, { headers: { traceparent } })).status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const logs = jsonLogsOf(container, folder);
        if (service) {
          expect(logs).toContainEqual(expect.objectContaining({ msg: 'Ping received', trace_id: traceId }));
          expect(await sentSpanOf(traceId)).toBe(true);
        } else if (since(FIRST_LOGGING_REQUESTED_PATH, manifest)) {
          expect(logs).toContainEqual(expect.objectContaining({ msg: 'GET / 200', path: '/', traceparent }));
          // One of the app's own routes, which nginx answers with the app's page, keeps its
          // path, and its query string, which can hold secrets, isn't logged.
          expect((await fetch(`${base}/orders/42?token=secret`)).status).toBe(200);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          const later = jsonLogsOf(container, folder);
          expect(later).toContainEqual(expect.objectContaining({ msg: 'GET /orders/42 200', path: '/orders/42' }));
          expect(JSON.stringify(later)).not.toContain('secret');
        } else {
          expect(logs).toContainEqual(expect.objectContaining({ msg: 'GET /index.html 200', traceparent }));
        }
      }
    } finally {
      spawnSync('docker', ['rm', '-f', container]);
      spawnSync('docker', ['rmi', '-f', image]);
      // Removed as soon as it's checked: every project has its own node_modules, which add up.
      rmSync(folder, { recursive: true, force: true });
    }
  }, 1_800_000);
});
