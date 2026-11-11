import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type CommandResult, CommandNotFoundError, lastLines, runCommand } from '../../shared/run-command.ts';
import {
  type ContainerLimits,
  type ContainerRequest,
  type Health,
  type HostRuntime,
  type HostTarget,
  type LogEntry,
  PermanentDeploymentError,
  type PulledImage,
  type StartedContainer,
} from '../application/ports.ts';
import { LOCAL_PROVIDER } from '../domain/hosting-providers.ts';

export type DockerCommand = (args: readonly string[], options: { readonly timeoutMs: number }) => Promise<CommandResult>;

export interface LocalDockerRuntimeOptions {
  /** Whether this server lets companies run applications on its own Docker. */
  readonly enabled: boolean;
  /** The platform's registry, the only one images are pulled from, and the account that may pull. */
  readonly registry: { readonly host: string; readonly username: string; readonly password: string };
  /** Where ports are published. 127.0.0.1, the default, lets only this machine reach them. */
  readonly bindAddress: string;
  readonly pullTimeoutMs: number;
  readonly docker?: string;
  /** Runs the Docker command line. Tests pass their own. */
  readonly exec?: DockerCommand;
  /** How long to wait between looks at a starting container. */
  readonly pollMs?: number;
}

/** What each container may use, so one application can't starve the machine. */
export const CONTAINER_LIMITS: ContainerLimits = { cpus: 1, memoryBytes: 512 * 1024 * 1024 };
const LIMITS = [
  '--memory',
  `${CONTAINER_LIMITS.memoryBytes / (1024 * 1024)}m`,
  '--cpus',
  String(CONTAINER_LIMITS.cpus),
  '--pids-limit',
  '256',
];

/** Signs of a problem that may pass, such as the Docker engine restarting or a network blip. */
const TEMPORARY = [
  'Cannot connect to the Docker daemon',
  'error during connect',
  'i/o timeout',
  'TLS handshake timeout',
  'connection reset by peer',
  'connection refused',
  'toomanyrequests',
  '503 Service Unavailable',
  '502 Bad Gateway',
];

const IMAGE_BY_DIGEST = /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/;
const CONTAINER_NAME = /^[a-z0-9][a-z0-9_.-]{1,127}$/;
const PORT_IN_USE = /port is already allocated|address already in use/i;

interface ContainerState {
  Status?: string;
  ExitCode?: number;
  Health?: { Status?: string; Log?: { Output?: string; ExitCode?: number }[] } | null;
}

/**
 * Runs applications as containers on the Docker of the machine that runs DreamDevOps.
 * Each environment gets one container and its own network, and the version before is
 * kept, stopped, until the new one is healthy, so it can come back.
 *
 * Containers run hardened: no capabilities, no privilege escalation, and limited memory,
 * CPU and processes. Images run only by digest, and only from the platform's registry.
 */
export class LocalDockerRuntime implements HostRuntime {
  readonly provider = LOCAL_PROVIDER;
  readonly #options: LocalDockerRuntimeOptions;
  readonly #exec: DockerCommand;
  readonly #pollMs: number;

  constructor(options: LocalDockerRuntimeOptions) {
    this.#options = options;
    const docker = options.docker ?? 'docker';
    this.#exec = options.exec ?? ((args, { timeoutMs }) => runCommand(docker, args, { timeoutMs }));
    this.#pollMs = options.pollMs ?? 1_000;
  }

  unavailableReason(): string | null {
    return this.#options.enabled
      ? null
      : 'Running applications on this machine is turned off on this server. An administrator can turn it on with LOCAL_HOSTING=on.';
  }

  async pull(_target: HostTarget, image: string): Promise<PulledImage> {
    this.#assertImage(image);
    const config = await mkdtemp(join(tmpdir(), 'dreamdevops-docker-'));
    try {
      const { host, username, password } = this.#options.registry;
      // Credentials written here are used instead of any the machine has, and removed after.
      await writeFile(
        join(config, 'config.json'),
        JSON.stringify({ auths: { [host]: { auth: Buffer.from(`${username}:${password}`).toString('base64') } } }),
        { mode: 0o600 },
      );
      const pulled = await this.#docker(['--config', config, 'pull', '--quiet', image], this.#options.pullTimeoutMs);
      if (pulled.code !== 0) {
        const log = lastLines(pulled.stderr);
        if (TEMPORARY.some((sign) => log.includes(sign))) {
          throw new Error(`Docker couldn't pull the image: ${log}`);
        }
        throw new PermanentDeploymentError(`The image couldn't be pulled: ${log}`);
      }
    } finally {
      await rm(config, { recursive: true, force: true });
    }
    return this.#inspectImage(image);
  }

  async start(target: HostTarget, request: ContainerRequest): Promise<StartedContainer> {
    this.#assertImage(request.image);
    this.#assertName(request.name);
    this.#assertName(request.network);
    const previous = previousName(request.name);
    await this.#ensureNetwork(request.network);

    // Keeps the version before, stopped, so it can come back if the new one isn't healthy.
    // A leftover new container from an attempt that didn't finish is replaced.
    const current = await this.#exists(request.name);
    const kept = await this.#exists(previous);
    const replaced = current || kept;
    try {
      if (current && kept) {
        await this.#forceRemove(request.name);
      } else if (current) {
        check(await this.#docker(['rename', request.name, previous], 30_000), 'rename the running version');
        check(await this.#docker(['stop', '--time', '20', previous], 60_000), 'stop the running version');
      }
      const { exposedPorts } = await this.#inspectImage(request.image);
      const containerPort = exposedPorts.find((port) => /^\d{1,5}\/tcp$/.test(port)) ?? null;
      let run = await this.#run(request, containerPort, request.preferredPort);
      if (run.code !== 0 && request.preferredPort !== null && PORT_IN_USE.test(run.stderr)) {
        // Someone else took its old port, so it gets a new one.
        await this.#forceRemove(request.name);
        run = await this.#run(request, containerPort, null);
      }
      if (run.code !== 0) {
        const log = lastLines(run.stderr);
        if (TEMPORARY.some((sign) => log.includes(sign))) {
          throw new Error(`Docker couldn't start the container: ${log}`);
        }
        throw new PermanentDeploymentError(`The container couldn't start: ${log}`);
      }
      const port = containerPort === null ? null : await this.#publishedPort(request.name, containerPort);
      return {
        port,
        address: port === null ? null : `http://${this.#publicHost(target)}:${port}`,
        replaced,
        limits: CONTAINER_LIMITS,
      };
    } catch (error) {
      // Nothing new started, so the version before runs again, as if nothing happened.
      await this.rollBack(target, request.name).catch(() => false);
      throw error;
    }
  }

  async waitUntilHealthy(_target: HostTarget, name: string, timeoutMs: number): Promise<Health> {
    this.#assertName(name);
    const deadline = Date.now() + timeoutMs;
    let runningLooks = 0;
    let last = 'It hasn’t reported its health yet.';
    for (;;) {
      const inspected = await this.#docker(['container', 'inspect', '--format', '{{json .State}}', name], 30_000);
      if (inspected.code !== 0) {
        return { healthy: false, detail: 'The container is gone.' };
      }
      const state = JSON.parse(inspected.stdout) as ContainerState;
      if (state.Status === 'exited' || state.Status === 'dead') {
        const logs = await this.#docker(['logs', '--tail', '20', name], 30_000);
        const output = lastLines(`${logs.stdout}\n${logs.stderr}`);
        return {
          healthy: false,
          detail: `It stopped with exit code ${state.ExitCode ?? 'unknown'}.${output === '' ? '' : ` Its last output: ${output}`}`,
        };
      }
      const health = state.Health?.Status;
      const lastCheck = lastLines(state.Health?.Log?.at(-1)?.Output ?? '', 3);
      if (lastCheck !== '') {
        last = `Its last health check said: ${lastCheck}`;
      }
      if (health === 'healthy') {
        return { healthy: true, detail: 'Its health check passed.' };
      }
      if (health === 'unhealthy') {
        return { healthy: false, detail: `Its health check failed. ${last}` };
      }
      if (health === undefined && state.Status === 'running') {
        // Without a health check, staying up for a few looks is the best sign there is.
        runningLooks += 1;
        if (runningLooks >= 3) {
          return { healthy: true, detail: 'It keeps running. The image has no health check, so that’s all that can be checked.' };
        }
      }
      if (Date.now() >= deadline) {
        return { healthy: false, detail: `It wasn’t healthy within ${Math.round(timeoutMs / 1000)} seconds. ${last}` };
      }
      await sleep(this.#pollMs);
    }
  }

  async commit(_target: HostTarget, name: string): Promise<void> {
    this.#assertName(name);
    await this.#forceRemove(previousName(name));
  }

  async rollBack(_target: HostTarget, name: string): Promise<boolean> {
    this.#assertName(name);
    const previous = previousName(name);
    await this.#forceRemove(name);
    if (!(await this.#exists(previous))) {
      return false;
    }
    const renamed = await this.#docker(['rename', previous, name], 30_000);
    if (renamed.code !== 0) {
      return false;
    }
    return (await this.#docker(['start', name], 60_000)).code === 0;
  }

  async remove(_target: HostTarget, name: string, network: string): Promise<void> {
    this.#assertName(name);
    this.#assertName(network);
    await this.#forceRemove(name);
    await this.#forceRemove(previousName(name));
    const removed = await this.#docker(['network', 'rm', network], 30_000);
    if (removed.code !== 0 && !/not found|no such network/i.test(removed.stderr)) {
      throw new Error(`Docker couldn't remove the network: ${lastLines(removed.stderr)}`);
    }
  }

  async logs(_target: HostTarget, name: string, options: { readonly since: Date; readonly limit: number }): Promise<LogEntry[]> {
    this.#assertName(name);
    const limit = Math.max(1, Math.min(Math.floor(options.limit), MAX_LOG_LINES));
    const result = await this.#docker(
      ['logs', '--timestamps', '--since', options.since.toISOString(), '--tail', String(limit), name],
      30_000,
    );
    if (result.code !== 0) {
      if (/no such container/i.test(result.stderr)) {
        return [];
      }
      throw new Error(`Docker couldn't read the logs: ${lastLines(result.stderr)}`);
    }
    // Docker passes on what the container wrote to each stream on its own, so the two are
    // put back in order by the time Docker gave each line.
    return [...logEntries(result.stdout, 'stdout'), ...logEntries(result.stderr, 'stderr')]
      .sort((left, right) => left.at.getTime() - right.at.getTime())
      .slice(-limit);
  }

  /**
   * Starts the container. Its variables go through an env file only its owner can read,
   * in a folder of its own, removed as soon as Docker has read it, so no value ever
   * appears in a command's arguments, which every user of the machine can see.
   */
  async #run(request: ContainerRequest, containerPort: string | null, hostPort: number | null): Promise<CommandResult> {
    const publish =
      containerPort === null
        ? []
        : ['--publish', `${this.#options.bindAddress}:${hostPort ?? ''}:${containerPort.replace('/tcp', '')}`];
    const folder = await mkdtemp(join(tmpdir(), 'dreamdevops-env-'));
    try {
      const envFile = join(folder, 'container.env');
      await writeFile(envFile, envFileText(request.environment), { mode: 0o600 });
      return await this.#docker(
        [
          'run',
          '--detach',
          '--name',
          request.name,
          '--network',
          request.network,
          '--restart',
          'unless-stopped',
          ...LIMITS,
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          // Checks health often while starting, so a deployment doesn't wait for the image's own interval.
          '--health-interval',
          '5s',
          ...Object.entries(request.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
          '--env-file',
          envFile,
          ...publish,
          request.image,
        ],
        120_000,
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  async #inspectImage(image: string): Promise<PulledImage> {
    const inspected = await this.#docker(['image', 'inspect', '--format', '{{json .}}', image], 60_000);
    if (inspected.code !== 0) {
      throw new Error(`Docker couldn't read the image: ${lastLines(inspected.stderr)}`);
    }
    const details = JSON.parse(inspected.stdout) as { Size?: number; Config?: { ExposedPorts?: Record<string, object> | null } };
    return { sizeBytes: details.Size ?? 0, exposedPorts: Object.keys(details.Config?.ExposedPorts ?? {}).sort() };
  }

  async #publishedPort(name: string, containerPort: string): Promise<number | null> {
    const result = await this.#docker(['port', name, containerPort], 30_000);
    const match = /:(\d+)\s*$/m.exec(result.stdout.split('\n')[0] ?? '');
    return result.code === 0 && match !== null ? Number(match[1]) : null;
  }

  async #ensureNetwork(network: string): Promise<void> {
    if ((await this.#docker(['network', 'inspect', network], 30_000)).code === 0) {
      return;
    }
    const created = await this.#docker(['network', 'create', '--label', 'dreamdevops.managed=true', network], 30_000);
    if (created.code !== 0 && !/already exists/i.test(created.stderr)) {
      throw new Error(`Docker couldn't create the network: ${lastLines(created.stderr)}`);
    }
  }

  async #exists(name: string): Promise<boolean> {
    return (await this.#docker(['container', 'inspect', '--format', '{{.Id}}', name], 30_000)).code === 0;
  }

  async #forceRemove(name: string): Promise<void> {
    const removed = await this.#docker(['rm', '--force', name], 60_000);
    if (removed.code !== 0 && !/no such container/i.test(removed.stderr)) {
      throw new Error(`Docker couldn't remove ${name}: ${lastLines(removed.stderr)}`);
    }
  }

  #publicHost(target: HostTarget): string {
    const configured = target.settings['publicHost'];
    if (typeof configured === 'string' && configured !== '') {
      return configured;
    }
    const bind = this.#options.bindAddress;
    return bind === '127.0.0.1' || bind === '0.0.0.0' || bind === '::' ? 'localhost' : bind;
  }

  async #docker(args: readonly string[], timeoutMs: number): Promise<CommandResult> {
    try {
      return await this.#exec(args, { timeoutMs });
    } catch (error) {
      if (error instanceof CommandNotFoundError) {
        throw new PermanentDeploymentError(
          'Docker isn’t installed on the machine that runs DreamDevOps, so it can’t run applications.',
        );
      }
      throw error;
    }
  }

  #assertImage(image: string): void {
    if (!IMAGE_BY_DIGEST.test(image) || image.length > 400) {
      throw new PermanentDeploymentError(`"${image}" isn't an image named by its digest.`);
    }
    if (!image.startsWith(`${this.#options.registry.host}/`)) {
      throw new PermanentDeploymentError('Only images from the platform’s registry can run.');
    }
  }

  #assertName(name: string): void {
    if (!CONTAINER_NAME.test(name)) {
      throw new PermanentDeploymentError(`"${name}" isn't a valid container or network name.`);
    }
  }
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Docker's env file format: one NAME=value per line, taken as written. Values that would
 * break it, such as ones with line breaks, are refused rather than changed.
 */
export function envFileText(environment: Readonly<Record<string, string>>): string {
  return Object.entries(environment)
    .map(([name, value]) => {
      // eslint-disable-next-line no-control-regex
      if (!VARIABLE_NAME.test(name) || /[\r\n\u0000]/.test(value)) {
        throw new PermanentDeploymentError(`${name} can't be given to the container as it is.`);
      }
      return `${name}=${value}\n`;
    })
    .join('');
}

/** The most lines read at once, so a chatty application can't flood the API. */
const MAX_LOG_LINES = 1_000;
/** Longer lines are cut, for the same reason. */
const MAX_LOG_LINE_LENGTH = 8 * 1024;
/** Docker's --timestamps prefix, such as 2026-11-10T12:00:00.123456789Z, then a space. */
const LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2}) ?(.*)$/;

/**
 * The lines of `docker logs --timestamps`, each with its time. A line without one, such as
 * the start of output that was cut short, is left out.
 */
export function logEntries(output: string, stream: LogEntry['stream']): LogEntry[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = LOG_TIMESTAMP.exec(line);
    if (match === null) {
      return [];
    }
    const [, seconds, fraction = '', zone, text = ''] = match;
    const at = new Date(`${seconds}.${fraction.padEnd(3, '0').slice(0, 3)}${zone}`);
    return Number.isNaN(at.getTime()) ? [] : [{ at, stream, text: text.slice(0, MAX_LOG_LINE_LENGTH) }];
  });
}

function check(result: CommandResult, what: string): void {
  if (result.code !== 0) {
    throw new Error(`Docker couldn't ${what}: ${lastLines(result.stderr)}`);
  }
}

/** The name the version before has while the new one starts. */
function previousName(name: string): string {
  return `${name}-previous`;
}
