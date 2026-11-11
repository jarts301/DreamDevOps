import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareVersions } from '../src/blueprints/domain/blueprint.ts';
import { BlueprintLibrary } from '../src/blueprints/infrastructure/blueprint-library.ts';

// Checks that every blueprint version produces a project that installs, passes its own
// checks, builds an image, and starts healthy as a read-only, non-root container. From
// 1.2.0, it also checks the container sends its metrics where the platform says.
// It's slow and needs Docker and the internet: npm run test:scaffolds

const BLUEPRINTS = fileURLToPath(new URL('../../../blueprints', import.meta.url));
const library = BlueprintLibrary.load(BLUEPRINTS);
const folders: string[] = [];

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`.slice(-4_000));
  }
  return result.stdout.trim();
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

/** Versions from this one on send metrics when the platform says where. */
const FIRST_WITH_METRICS = '1.2.0';

/** What containers send over OTLP, as the platform's metrics store would receive it. */
const received: string[] = [];
const metricsSink = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk: string) => (body += chunk));
  request.on('end', () => {
    received.push(body);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
});

/** The metrics names sent with this environment's attribute, once all the expected ones arrived. */
async function metricsOf(environmentId: string, expected: readonly string[]): Promise<string[]> {
  const deadline = Date.now() + 60_000;
  let names = new Set<string>();
  while (Date.now() < deadline) {
    names = new Set(
      received.flatMap((body) => {
        const payload = JSON.parse(body) as {
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
  await new Promise<void>((resolve) => metricsSink.close(() => resolve()));
  for (const folder of folders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe.each(library.all())('the $key $version blueprint', (manifest) => {
  it('makes a project that passes its own checks and runs as a healthy container', async () => {
    const folder = mkdtempSync(join(tmpdir(), `scaffold-${manifest.key}-`));
    folders.push(folder);
    for (const file of library.render(manifest.key, manifest.version, { name: 'Scaffold Check', slug: 'scaffold-check' })) {
      mkdirSync(dirname(join(folder, file.path)), { recursive: true });
      writeFileSync(join(folder, file.path), file.content);
    }

    for (const script of [['ci'], ['run', 'lint'], ['run', 'typecheck'], ['test'], ['run', 'build']]) {
      run('npm', script, folder);
    }

    const image = `dreamdevops-scaffold-check-${manifest.key}:${manifest.version}`;
    run('docker', ['build', '--quiet', '-t', image, '.'], folder);
    // The settings the platform gives every container, so it sends its metrics.
    const environmentId = `scaffold-check-${manifest.key}-${manifest.version}`;
    const metricsPort = (metricsSink.address() as AddressInfo).port;
    const telemetry = [
      ['--add-host', 'host.docker.internal:host-gateway'],
      ['-e', `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://host.docker.internal:${metricsPort}/v1/metrics`],
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

      if (compareVersions(manifest.version, FIRST_WITH_METRICS) >= 0) {
        // A request that isn't a health check, so a service has a request to measure.
        await fetch(`${base}/`);
        const expected = ['process.cpu.time', 'process.memory.usage'];
        if (manifest.applicationType === 'restful-service') {
          expected.push('http.server.request.duration');
        }
        expect(await metricsOf(environmentId, expected)).toEqual(expect.arrayContaining(expected));
      }
    } finally {
      spawnSync('docker', ['rm', '-f', container]);
      spawnSync('docker', ['rmi', '-f', image]);
    }
  }, 900_000);
});
