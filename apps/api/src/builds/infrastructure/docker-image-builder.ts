import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ImageBuilder, type ImageDetails, PermanentBuildError } from '../application/ports.ts';
import { CommandNotFoundError, lastLines, runCommand } from '../../shared/run-command.ts';

export interface DockerImageBuilderOptions {
  /** Where images are pushed, such as localhost:3000, and the account that may push there. */
  readonly registry: { readonly host: string; readonly username: string; readonly password: string };
  readonly buildTimeoutMs: number;
  readonly docker?: string;
}

/** Signs of a problem that may pass, such as the Docker engine restarting or a network blip. */
const TEMPORARY = [
  'Cannot connect to the Docker daemon',
  'error during connect',
  'i/o timeout',
  'TLS handshake timeout',
  'connection reset by peer',
  'connection refused',
  'no such host',
  'toomanyrequests',
  '503 Service Unavailable',
  '502 Bad Gateway',
];

const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._:/-]*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/;

/**
 * Builds and pushes images with the Docker command line on the API's machine. Each
 * push uses its own private, throwaway Docker configuration, so the platform's registry
 * password never reaches the person's own Docker settings or keychain.
 */
export class DockerImageBuilder implements ImageBuilder {
  readonly #options: DockerImageBuilderOptions;
  readonly #docker: string;

  constructor(options: DockerImageBuilderOptions) {
    this.#options = options;
    this.#docker = options.docker ?? 'docker';
  }

  async build(request: { directory: string; image: string; labels: Readonly<Record<string, string>> }): Promise<void> {
    assertReference(request.image);
    const result = await this.#run(
      [
        'build',
        '--file',
        join(request.directory, 'Dockerfile'),
        '--tag',
        request.image,
        ...Object.entries(request.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
        request.directory,
      ],
      this.#options.buildTimeoutMs,
    );
    if (result.code !== 0) {
      const log = buildFailure(result.stderr);
      // A failing Dockerfile step fails again next time, so only engine or network trouble is retried.
      if (TEMPORARY.some((sign) => log.includes(sign))) {
        throw new Error(`Docker couldn't build the image: ${log}`);
      }
      throw new PermanentBuildError(`The image didn't build: ${log}`);
    }
  }

  async inspect(image: string): Promise<ImageDetails> {
    assertReference(image);
    const result = await this.#run(['image', 'inspect', '--format', '{{json .}}', image], 60_000);
    if (result.code !== 0) {
      throw new Error(`Docker couldn't inspect the image: ${lastLines(result.stderr)}`);
    }
    const details = JSON.parse(result.stdout) as {
      Size?: number;
      Config?: { User?: string; Healthcheck?: { Test?: string[] } | null; ExposedPorts?: Record<string, object> | null };
    };
    const test = details.Config?.Healthcheck?.Test ?? [];
    return {
      user: details.Config?.User ?? '',
      healthcheck: test.length > 0 && test[0] !== 'NONE',
      sizeBytes: details.Size ?? 0,
      exposedPorts: Object.keys(details.Config?.ExposedPorts ?? {}).sort(),
    };
  }

  async push(image: string, target: string): Promise<void> {
    assertReference(image);
    assertReference(target);
    if (!target.startsWith(`${this.#options.registry.host}/`)) {
      throw new PermanentBuildError('Images can only be published to the platform registry.');
    }
    const tagged = await this.#run(['tag', image, target], 60_000);
    if (tagged.code !== 0) {
      throw new Error(`Docker couldn't name the image: ${lastLines(tagged.stderr)}`);
    }
    const config = await mkdtemp(join(tmpdir(), 'dreamdevops-docker-'));
    try {
      const { host, username, password } = this.#options.registry;
      // Credentials written here are used instead of any credential helper the machine has.
      await writeFile(
        join(config, 'config.json'),
        JSON.stringify({ auths: { [host]: { auth: Buffer.from(`${username}:${password}`).toString('base64') } } }),
        { mode: 0o600 },
      );
      const pushed = await this.#run(['--config', config, 'push', target], this.#options.buildTimeoutMs);
      if (pushed.code !== 0) {
        const log = lastLines(pushed.stderr);
        if (/unauthorized|denied|authentication required/i.test(log)) {
          throw new PermanentBuildError(`The registry refused the platform's credentials: ${log}`);
        }
        throw new Error(`Docker couldn't publish the image: ${log}`);
      }
    } finally {
      await rm(config, { recursive: true, force: true });
    }
  }

  async remove(images: readonly string[]): Promise<void> {
    for (const image of images) {
      if (IMAGE_REFERENCE.test(image)) {
        await this.#run(['image', 'rm', image], 60_000).catch(() => undefined);
      }
    }
  }

  async #run(args: readonly string[], timeoutMs: number) {
    try {
      return await runCommand(this.#docker, args, { timeoutMs });
    } catch (error) {
      if (error instanceof CommandNotFoundError) {
        throw new PermanentBuildError('Docker isn\'t installed on the machine that runs the API, so images can\'t be built.');
      }
      throw error;
    }
  }
}

/** The most lines of a failed step's output kept, and the most characters of the whole. */
const FAILURE_LINES = 15;
const FAILURE_LENGTH = 2_000;

/**
 * Why a build failed, for people: the step that failed, its last lines of output, such as
 * a compiler's error, and Docker's own summary. Docker ends with an excerpt of the
 * Dockerfile, which says where a build failed but not why, so the step's output, which
 * Docker repeats just before it, is what's kept.
 */
export function buildFailure(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trimEnd());
  const summary = lines.findLast((line) => line.startsWith('ERROR:'));
  // Such as " > [build 6/6] RUN cargo build --release --locked:", then the step's last lines.
  const start = lines.findLastIndex((line) => /^ > \[[^\]]+\] .*:$/.test(line));
  if (start === -1) {
    return lastLines(stderr);
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith('------'));
  const output = lines
    .slice(start + 1, end === -1 ? undefined : end)
    // Each line starts with the seconds since the step started, which don't help.
    .map((line) => line.replace(/^\d+(\.\d+)?( |$)/, ''))
    .filter((line) => line.trim() !== '')
    .slice(-FAILURE_LINES);
  const step = lines[start]!.trim().replace(/^> /, '').replace(/:$/, '');
  return [step, ...output, ...(summary === undefined ? [] : [summary])].join('\n').slice(-FAILURE_LENGTH);
}

function assertReference(image: string): void {
  if (!IMAGE_REFERENCE.test(image) || image.length > 255) {
    throw new PermanentBuildError(`"${image}" isn't a valid image name.`);
  }
}
