import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDomainEvent, parseCompanyId } from '@dreamdevops/shared-kernel';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostRuntimes, PermanentDeploymentError } from '../src/environments/application/ports.ts';
import {
  assertDeploymentConfirmed,
  assertMayBecomeProduction,
  containerName,
  deploymentKind,
  describeLimits,
  deploymentSteps,
  imageProblem,
  networkName,
} from '../src/environments/domain/deployment.ts';
import { type DockerCommand, LocalDockerRuntime } from '../src/environments/infrastructure/local-docker-runtime.ts';
import { summarize } from '../src/notifications/domain/event-catalog.ts';
import type { CommandResult } from '../src/shared/run-command.ts';
import { COMPANY_A, FakeHostRuntime } from './fakes.ts';
import { createTestApp } from './test-app.ts';

const release = { version: '1.5.0', kind: 'release', productive: true };
const candidate = { version: '1.5.0-rc.2', kind: 'release-candidate', productive: false };
const development = { version: '1.5.0-dev.pr12.1', kind: 'development', productive: false };

describe('what may run where', () => {
  const production = { name: 'Production', production: true };
  const staging = { name: 'Staging', production: false };

  it('lets production run only releases', () => {
    expect(imageProblem(production, release)).toBeNull();
    expect(imageProblem(production, candidate)).toBe(
      'Production is a production environment, so it runs only releases. 1.5.0-rc.2 is a release candidate.',
    );
    expect(imageProblem(production, development)).toBe(
      'Production is a production environment, so it runs only releases. 1.5.0-dev.pr12.1 is a development image.',
    );
  });

  it('lets other environments run any version that built', () => {
    for (const image of [release, candidate, development]) {
      expect(imageProblem(staging, image)).toBeNull();
    }
  });

  it('doesn’t make an environment production while it runs, or is about to run, anything but a release', () => {
    expect(() => assertMayBecomeProduction(staging, release, false)).not.toThrow();
    expect(() => assertMayBecomeProduction(staging, null, false)).not.toThrow();
    expect(() => assertMayBecomeProduction(staging, candidate, false)).toThrow(
      'Staging runs 1.5.0-rc.2, which is a release candidate. Production runs only releases, so deploy a release to it, or stop it, first.',
    );
    expect(() => assertMayBecomeProduction(staging, release, true)).toThrow('Wait for the deployment to Staging to finish first.');
  });

  it('asks for production’s name before deploying to it', () => {
    expect(() => assertDeploymentConfirmed(staging, undefined)).not.toThrow();
    expect(() => assertDeploymentConfirmed(production, 'Production')).not.toThrow();
    for (const slip of [undefined, '', 'production', 'Production ']) {
      expect(() => assertDeploymentConfirmed(production, slip)).toThrow(
        'This deploys to production. To confirm, type its name exactly: Production',
      );
    }
  });
});

describe('deployments', () => {
  it('move what runs when it runs on another target than the environment’s', () => {
    expect(deploymentKind(null, 'b')).toBe('deploy');
    expect(deploymentKind('b', 'b')).toBe('deploy');
    expect(deploymentKind('a', 'b')).toBe('move');
  });

  it('say what their containers may use, in words', () => {
    expect(describeLimits({ cpus: 1, memoryBytes: 512 * 1024 * 1024 })).toBe('1 CPU and 512 MiB of memory');
    expect(describeLimits({ cpus: 0.5, memoryBytes: 2 * 1024 * 1024 * 1024 })).toBe('0.5 CPUs and 2 GiB of memory');
    expect(describeLimits(null)).toBe('None');
  });

  it('go through the steps each kind needs', () => {
    expect(deploymentSteps('deploy')).toEqual(['validate', 'verify', 'pull', 'start', 'health']);
    expect(deploymentSteps('move')).toEqual(['validate', 'verify', 'pull', 'start', 'health', 'retire']);
    expect(deploymentSteps('stop')).toEqual(['validate', 'stop']);
  });

  it('name containers and networks so people recognize them, and no two environments share one', () => {
    const id = '0b5f8a2c-1d3e-4f5a-8b9c-0d1e2f3a4b5c';
    expect(containerName('billing-api', 'staging', id)).toBe('dreamdevops-billing-api-staging-0b5f8a2c1d3e');
    expect(containerName('billing-api', 'staging', '1b5f8a2c-1d3e-4f5a-8b9c-0d1e2f3a4b5c')).not.toBe(
      containerName('billing-api', 'staging', id),
    );
    const long = containerName('a'.repeat(80), 'b'.repeat(40), id);
    expect(long).toMatch(/^[a-z0-9][a-z0-9_.-]{1,127}$/);
    expect(long.length).toBeLessThanOrEqual(70);
    expect(networkName(id)).toBe('dreamdevops-env-0b5f8a2c1d3e4f5a8b9c0d1e2f3a4b5c');
  });

  it('run only on providers the platform has a runtime for, when it’s turned on', () => {
    const local = new FakeHostRuntime('local');
    const runtimes = new HostRuntimes([local]);

    expect(runtimes.problem({ key: 'local', name: 'This machine' })).toBeNull();
    expect(runtimes.problem({ key: 'aws', name: 'Amazon Web Services' })).toBe(
      'Deploying to Amazon Web Services targets isn’t available yet.',
    );
    local.enabled = false;
    expect(runtimes.problem({ key: 'local', name: 'This machine' })).toBe('Running applications on this host is turned off.');
  });
});

describe('deployment notifications', () => {
  const event = (eventType: string, payload: object) =>
    createDomainEvent({ eventType, companyId: parseCompanyId(COMPANY_A), payload });
  const base = {
    environmentName: 'Production',
    applicationName: 'Billing',
    production: true,
    version: '1.5.0',
    targetName: 'This machine',
  };

  it('say what was deployed where, and where to reach it', () => {
    expect(summarize(event('DeploymentSucceeded', { ...base, kind: 'deploy', address: 'http://localhost:49153' }), 'Acme')).toBe(
      'Acme: 1.5.0 was deployed to the production environment "Production" of "Billing": http://localhost:49153.',
    );
    expect(summarize(event('DeploymentQueued', { ...base, kind: 'stop', reason: 'Retiring the old service' }), 'Acme')).toBe(
      'Acme: Stopping 1.5.0 in the production environment "Production" of "Billing" was requested: "Retiring the old service".',
    );
    expect(
      summarize(event('DeploymentFailed', { ...base, kind: 'deploy', step: 'Wait until it’s healthy', stillRunning: '1.4.0' }), 'Acme'),
    ).toBe(
      'Acme: Deploying 1.5.0 to the production environment "Production" of "Billing" failed at "Wait until it’s healthy". 1.4.0 still runs.',
    );
  });
});

/** A Docker command line in memory, with containers, networks and ports, like the real one. */
class SimulatedDocker {
  readonly calls: string[][] = [];
  readonly containers = new Map<
    string,
    { image: string; status: string; port: number | null; health: string[]; exitCode: number; logs: string; errors?: string; env?: string }
  >();
  /** While set, Docker itself fails, as when its engine stopped. */
  down = false;
  readonly networks = new Set<string>();
  readonly takenPorts = new Set<number>();
  /** Images the registry has. */
  readonly published = new Set<string>();
  /** How each new container reports its health, look by look. */
  healthOf: (image: string) => string[] = () => ['starting', 'healthy'];
  exposedPorts: Record<string, object> = { '8080/tcp': {} };
  /** Images whose containers can't be created. */
  readonly broken = new Set<string>();
  /** Where each run found its env file. */
  readonly envFiles: string[] = [];
  pulledWith: unknown = null;
  #nextPort = 49_153;

  readonly exec: DockerCommand = async (args) => {
    this.calls.push([...args]);
    const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
    const error = (stderr: string, code = 1): CommandResult => ({ code, stdout: '', stderr });
    const missing = (name: string) => error(`Error response from daemon: No such container: ${name}`);
    if (args[0] === '--config') {
      this.pulledWith = JSON.parse(readFileSync(join(args[1]!, 'config.json'), 'utf8'));
      const image = args.at(-1)!;
      return this.published.has(image) ? ok(image) : error('Error response from daemon: manifest unknown');
    }
    const [command, sub] = args;
    const name = args.at(-1)!;
    const container = this.containers.get(name);
    switch (`${command} ${sub}`) {
      case 'image inspect':
        return ok(JSON.stringify({ Size: 52_000_000, Config: { ExposedPorts: this.exposedPorts } }));
      case 'network inspect':
        return this.networks.has(name) ? ok('[]') : error(`network ${name} not found`);
      case 'network create':
        this.networks.add(name);
        return ok();
      case 'network rm':
        return this.networks.delete(name) ? ok() : error(`Error response from daemon: network ${name} not found`);
      case 'container inspect': {
        if (container === undefined) {
          return missing(name);
        }
        if (args[3] === '{{.Id}}') {
          return ok('abc');
        }
        const health = container.health.length > 1 ? container.health.shift()! : container.health[0];
        return ok(
          JSON.stringify({
            Status: container.status,
            ExitCode: container.exitCode,
            Health: health === undefined ? undefined : { Status: health, Log: [{ Output: `check said ${health}` }] },
          }),
        );
      }
    }
    switch (command) {
      case 'rename': {
        const [, from, to] = args;
        const moving = this.containers.get(from!);
        if (moving === undefined) {
          return missing(from!);
        }
        this.containers.delete(from!);
        this.containers.set(to!, moving);
        return ok();
      }
      case 'stop':
        if (container === undefined) return missing(name);
        container.status = 'exited';
        if (container.port !== null) this.takenPorts.delete(container.port);
        return ok();
      case 'start':
        if (container === undefined) return missing(name);
        container.status = 'running';
        if (container.port !== null) this.takenPorts.add(container.port);
        return ok();
      case 'rm':
        if (container === undefined) return missing(name);
        this.containers.delete(name);
        if (container.port !== null && container.status === 'running') this.takenPorts.delete(container.port);
        return ok();
      case 'run': {
        const containerName = args[args.indexOf('--name') + 1]!;
        const publish = args.includes('--publish') ? args[args.indexOf('--publish') + 1]! : null;
        const requested = publish === null ? null : publish.split(':')[1]!;
        const port = publish === null ? null : requested === '' ? this.#nextPort++ : Number(requested);
        if (this.broken.has(name)) {
          this.containers.set(containerName, { image: name, status: 'created', port: null, health: [], exitCode: 0, logs: '' });
          return error('docker: Error response from daemon: failed to create task: exec format error', 125);
        }
        if (port !== null && this.takenPorts.has(port)) {
          this.containers.set(containerName, { image: name, status: 'created', port: null, health: [], exitCode: 0, logs: '' });
          return error(`Bind for 127.0.0.1:${port} failed: port is already allocated`, 125);
        }
        if (port !== null) this.takenPorts.add(port);
        // Docker reads the env file as the container is created, so it's read here too.
        const envFile = args[args.indexOf('--env-file') + 1]!;
        this.envFiles.push(envFile);
        const env = readFileSync(envFile, 'utf8');
        this.containers.set(containerName, { image: name, status: 'running', port, health: this.healthOf(name), exitCode: 0, logs: '', env });
        return ok('container-id');
      }
      case 'port': {
        const port = this.containers.get(args[1]!)?.port;
        return port == null ? error('no public port') : ok(`127.0.0.1:${port}\n`);
      }
      case 'logs':
        if (this.down) return error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
        if (container === undefined) return missing(name);
        // Docker passes on each of the container's outputs on its own.
        return { code: 0, stdout: container.logs, stderr: container.errors ?? '' };
      default:
        return error(`unknown command ${args.join(' ')}`);
    }
  };
}

describe('the local Docker runtime', () => {
  const target = { id: 't-1', name: 'This machine', provider: 'local', settings: {} };
  const registry = { host: 'localhost:3000', username: 'bot', password: 'fake-dummy-password' };
  const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
  const image = (n: number) => `localhost:3000/acme/billing@${digest(n)}`;
  const name = 'dreamdevops-billing-staging-0b5f8a2c1d3e';
  const network = 'dreamdevops-env-0b5f8a2c1d3e4f5a8b9c0d1e2f3a4b5c';
  const runtimeOn = (docker: SimulatedDocker, options: { bindAddress?: string } = {}) =>
    new LocalDockerRuntime({
      enabled: true,
      registry,
      bindAddress: options.bindAddress ?? '127.0.0.1',
      pullTimeoutMs: 10_000,
      exec: docker.exec,
      pollMs: 1,
    });
  const request = (n: number, preferredPort: number | null = null) => ({
    name,
    network,
    image: image(n),
    labels: { 'dreamdevops.version': `1.${n}.0` },
    environment: { LOG_LEVEL: 'info', DATABASE_URL: 'postgres://app:fake-dummy-secret@db/app' },
    preferredPort,
  });

  it('pulls only by digest from the platform registry, with throwaway credentials', async () => {
    const docker = new SimulatedDocker();
    docker.published.add(image(1));
    const runtime = runtimeOn(docker);

    expect(await runtime.pull(target, image(1))).toEqual({ sizeBytes: 52_000_000, exposedPorts: ['8080/tcp'] });

    expect(docker.pulledWith).toEqual({ auths: { 'localhost:3000': { auth: Buffer.from('bot:fake-dummy-password').toString('base64') } } });
    expect(existsSync(docker.calls[0]![1]!)).toBe(false);
    await expect(runtime.pull(target, 'localhost:3000/acme/billing:1.0.0')).rejects.toThrow(PermanentDeploymentError);
    await expect(runtime.pull(target, `docker.io/someone/billing@${digest(1)}`)).rejects.toThrow(
      'Only images from the platform’s registry can run.',
    );
    await expect(runtime.pull(target, image(2))).rejects.toThrow("The image couldn't be pulled: Error response from daemon: manifest unknown");
  });

  it('starts a hardened container on its own network, reachable only from this machine', async () => {
    const docker = new SimulatedDocker();
    const runtime = runtimeOn(docker);

    const started = await runtime.start(target, request(1));

    expect(started).toEqual({
      port: 49_153,
      address: 'http://localhost:49153',
      replaced: false,
      limits: { cpus: 1, memoryBytes: 536_870_912 },
    });
    expect(docker.networks.has(network)).toBe(true);
    const run = docker.calls.find((call) => call[0] === 'run')!;
    expect(run).toEqual(
      expect.arrayContaining(['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--pids-limit', '256']),
    );
    // What it reports is what Docker was told.
    expect(run.slice(run.indexOf('--memory'), run.indexOf('--memory') + 4)).toEqual(['--memory', '512m', '--cpus', '1']);
    expect(run.slice(run.indexOf('--network'), run.indexOf('--network') + 2)).toEqual(['--network', network]);
    expect(run.slice(run.indexOf('--restart'), run.indexOf('--restart') + 2)).toEqual(['--restart', 'unless-stopped']);
    expect(run.slice(-3)).toEqual(['--publish', '127.0.0.1::8080', image(1)]);
    expect(run).toContain('dreamdevops.version=1.1.0');
  });

  it('gives the container its variables through a private env file, never in its arguments', async () => {
    const docker = new SimulatedDocker();

    await runtimeOn(docker).start(target, request(1));

    expect(docker.containers.get(name)?.env).toBe('LOG_LEVEL=info\nDATABASE_URL=postgres://app:fake-dummy-secret@db/app\n');
    const run = docker.calls.find((call) => call[0] === 'run')!;
    expect(run.join(' ')).not.toContain('fake-dummy-secret');
    // The file was only the owner's, and is gone once Docker read it.
    expect(existsSync(docker.envFiles[0]!)).toBe(false);
    await expect(
      runtimeOn(docker).start(target, { ...request(2), environment: { BROKEN: 'one\ntwo' } }),
    ).rejects.toThrow("BROKEN can't be given to the container as it is.");
  });

  it('keeps the version before, stopped, until the new one is committed, and keeps its port', async () => {
    const docker = new SimulatedDocker();
    const runtime = runtimeOn(docker);
    const first = await runtime.start(target, request(1));

    const second = await runtime.start(target, request(2, first.port));

    expect(second).toEqual({ port: first.port, address: first.address, replaced: true, limits: first.limits });
    expect(docker.containers.get(`${name}-previous`)).toMatchObject({ image: image(1), status: 'exited' });
    expect(docker.containers.get(name)).toMatchObject({ image: image(2), status: 'running' });
    await runtime.commit(target, name);
    expect([...docker.containers.keys()]).toEqual([name]);
  });

  it('gets a new port when someone took its old one', async () => {
    const docker = new SimulatedDocker();
    docker.takenPorts.add(8_100);

    const started = await runtimeOn(docker).start(target, request(1, 8_100));

    expect(started.port).toBe(49_153);
    expect(docker.containers.get(name)?.status).toBe('running');
  });

  it('puts the version before back at once when the new one can’t start', async () => {
    const docker = new SimulatedDocker();
    const runtime = runtimeOn(docker);
    const first = await runtime.start(target, request(1));
    await runtime.commit(target, name);
    docker.broken.add(image(2));

    await expect(runtime.start(target, request(2, first.port))).rejects.toThrow(
      "The container couldn't start: docker: Error response from daemon: failed to create task: exec format error",
    );

    expect([...docker.containers.entries()]).toEqual([[name, expect.objectContaining({ image: image(1), status: 'running', port: first.port })]]);
  });

  it('publishes only a single TCP port the image exposes', async () => {
    const docker = new SimulatedDocker();
    docker.exposedPorts = { '8000-8010/tcp': {}, '53/udp': {} };

    const started = await runtimeOn(docker).start(target, request(1));

    expect(started.port).toBeNull();
    expect(docker.calls.find((call) => call[0] === 'run')).not.toContain('--publish');
  });

  it('rolls back to the version before, and says when there was none', async () => {
    const docker = new SimulatedDocker();
    const runtime = runtimeOn(docker);
    const first = await runtime.start(target, request(1));
    await runtime.commit(target, name);
    await runtime.start(target, request(2, first.port));

    expect(await runtime.rollBack(target, name)).toBe(true);
    expect([...docker.containers.entries()]).toEqual([[name, expect.objectContaining({ image: image(1), status: 'running' })]]);
    expect(await runtime.rollBack(target, name)).toBe(false);
    expect(docker.containers.size).toBe(0);
  });

  it('replaces a new container an earlier attempt left behind', async () => {
    const docker = new SimulatedDocker();
    const runtime = runtimeOn(docker);
    await runtime.start(target, request(1));
    await runtime.start(target, request(2));

    // The attempt stopped before it was healthy, and runs again.
    const again = await runtime.start(target, request(2));

    expect(again.replaced).toBe(true);
    expect(docker.containers.get(`${name}-previous`)?.image).toBe(image(1));
    expect(docker.containers.get(name)?.image).toBe(image(2));
  });

  it('waits for the image’s health check', async () => {
    const docker = new SimulatedDocker();
    const runtime = runtimeOn(docker);
    docker.healthOf = () => ['starting', 'starting', 'healthy'];
    await runtime.start(target, request(1));

    expect(await runtime.waitUntilHealthy(target, name, 5_000)).toEqual({ healthy: true, detail: 'Its health check passed.' });
  });

  it('says why a version isn’t healthy', async () => {
    const docker = new SimulatedDocker();
    const runtime = runtimeOn(docker);
    docker.healthOf = () => ['starting', 'unhealthy'];
    await runtime.start(target, request(1));
    expect(await runtime.waitUntilHealthy(target, name, 5_000)).toEqual({
      healthy: false,
      detail: 'Its health check failed. Its last health check said: check said unhealthy',
    });

    docker.containers.get(name)!.status = 'exited';
    docker.containers.get(name)!.exitCode = 1;
    docker.containers.get(name)!.logs = 'Error: PORT must be a whole number\n';
    expect(await runtime.waitUntilHealthy(target, name, 5_000)).toEqual({
      healthy: false,
      detail: 'It stopped with exit code 1. Its last output: Error: PORT must be a whole number',
    });

    docker.healthOf = () => ['starting'];
    await runtime.start(target, request(2));
    expect((await runtime.waitUntilHealthy(target, name, 20)).detail).toMatch(/^It wasn’t healthy within 0 seconds\./);
  });

  it('counts a container without a health check as healthy once it keeps running', async () => {
    const docker = new SimulatedDocker();
    const runtime = runtimeOn(docker);
    docker.healthOf = () => [];
    await runtime.start(target, request(1));

    expect(await runtime.waitUntilHealthy(target, name, 5_000)).toMatchObject({ healthy: true });
  });

  it('reads what a container wrote to both its outputs, in order, with when each line came', async () => {
    const docker = new SimulatedDocker();
    const runtime = runtimeOn(docker);
    await runtime.start(target, request(1));
    const container = docker.containers.get(name)!;
    container.logs = [
      '2026-11-10T12:00:01.123456789Z {"level":30,"msg":"Ping received"}',
      '2026-11-10T12:00:03.5Z plain text, with  spaces ',
      '',
    ].join('\n');
    // The start of a long error output can be cut, so a line can come without its time.
    container.errors = 'the end of a cut line\n2026-11-10T12:00:02+01:00 a warning\r\n';
    const since = new Date('2026-11-10T10:00:00.000Z');

    expect(await runtime.logs(target, name, { since, limit: 100 })).toEqual([
      { at: new Date('2026-11-10T11:00:02.000Z'), stream: 'stderr', text: 'a warning' },
      { at: new Date('2026-11-10T12:00:01.123Z'), stream: 'stdout', text: '{"level":30,"msg":"Ping received"}' },
      { at: new Date('2026-11-10T12:00:03.500Z'), stream: 'stdout', text: 'plain text, with  spaces ' },
    ]);
    expect(docker.calls.at(-1)).toEqual(['logs', '--timestamps', '--since', '2026-11-10T10:00:00.000Z', '--tail', '100', name]);
  });

  it('reads only the latest lines, never more than a thousand, and none once the container is gone', async () => {
    const docker = new SimulatedDocker();
    const runtime = runtimeOn(docker);
    await runtime.start(target, request(1));
    docker.containers.get(name)!.logs = '2026-11-10T12:00:01Z one\n2026-11-10T12:00:02Z two\n2026-11-10T12:00:03Z three\n';
    const since = new Date(0);

    expect((await runtime.logs(target, name, { since, limit: 2 })).map((entry) => entry.text)).toEqual(['two', 'three']);
    await runtime.logs(target, name, { since, limit: 50_000 });
    expect(docker.calls.at(-1)).toContain('1000');

    await runtime.remove(target, name, network);
    expect(await runtime.logs(target, name, { since, limit: 100 })).toEqual([]);
  });

  it('says when Docker can’t give the logs, and refuses names that could be read as options', async () => {
    const docker = new SimulatedDocker();
    const runtime = runtimeOn(docker);
    docker.down = true;

    await expect(runtime.logs(target, name, { since: new Date(0), limit: 10 })).rejects.toThrow(
      "Docker couldn't read the logs: Cannot connect to the Docker daemon",
    );
    await expect(runtime.logs(target, '--follow', { since: new Date(0), limit: 10 })).rejects.toThrow(PermanentDeploymentError);
  });

  it('removes everything of an environment, and is safe to repeat', async () => {
    const docker = new SimulatedDocker();
    const runtime = runtimeOn(docker);
    await runtime.start(target, request(1));
    await runtime.start(target, request(2));

    await runtime.remove(target, name, network);
    await runtime.remove(target, name, network);

    expect(docker.containers.size).toBe(0);
    expect(docker.networks.size).toBe(0);
  });

  it('uses the host name people reach this machine by', async () => {
    const docker = new SimulatedDocker();

    const started = await runtimeOn(docker, { bindAddress: '0.0.0.0' }).start(
      { ...target, settings: { publicHost: 'devbox.example.com' } },
      request(1),
    );

    expect(started.address).toBe('http://devbox.example.com:49153');
    expect(docker.calls.find((call) => call[0] === 'run')).toContain('0.0.0.0::8080');
  });

  it('publishes nothing for an image that listens on no port', async () => {
    const docker = new SimulatedDocker();
    docker.exposedPorts = {};

    const started = await runtimeOn(docker).start(target, request(1));

    expect(started).toEqual({ port: null, address: null, replaced: false, limits: { cpus: 1, memoryBytes: 536_870_912 } });
    expect(docker.calls.find((call) => call[0] === 'run')).not.toContain('--publish');
  });

  it('refuses names that could be read as options', async () => {
    const runtime = runtimeOn(new SimulatedDocker());

    await expect(runtime.start(target, { ...request(1), name: '--privileged' })).rejects.toThrow(PermanentDeploymentError);
    await expect(runtime.remove(target, name, '-d')).rejects.toThrow(PermanentDeploymentError);
  });

  it('explains when it’s turned off, or Docker isn’t installed', async () => {
    const off = new LocalDockerRuntime({ enabled: false, registry, bindAddress: '127.0.0.1', pullTimeoutMs: 1_000 });
    expect(off.unavailableReason()).toBe(
      'Running applications on this machine is turned off on this server. An administrator can turn it on with LOCAL_HOSTING=on.',
    );
    const missing = new LocalDockerRuntime({
      enabled: true,
      registry,
      bindAddress: '127.0.0.1',
      pullTimeoutMs: 1_000,
      docker: '/nonexistent/docker',
    });

    await expect(missing.remove(target, name, network)).rejects.toThrow(
      'Docker isn’t installed on the machine that runs DreamDevOps, so it can’t run applications.',
    );
  });
});

describe('deployment routes', () => {
  let app: INestApplication;
  const ENVIRONMENT = '00000000-0000-4000-8000-0000000000bb';
  const DEPLOYMENT = '00000000-0000-4000-8000-0000000000cc';

  beforeAll(async () => {
    app = await createTestApp({ config: { secureCookies: false } });
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['get', `/api/v1/company/environments/${ENVIRONMENT}/versions`],
    ['get', `/api/v1/company/environments/${ENVIRONMENT}/deployments`],
    ['post', `/api/v1/company/environments/${ENVIRONMENT}/deployments`],
    ['post', `/api/v1/company/environments/${ENVIRONMENT}/stop`],
    ['get', `/api/v1/company/deployments/${DEPLOYMENT}`],
  ] as const)('ask anonymous users to sign in: %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](path).expect(401);
  });
});
