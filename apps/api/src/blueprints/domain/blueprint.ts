import { createHash } from 'node:crypto';

/** What a blueprint version defines, read from its blueprint.json. */
export interface BlueprintManifest {
  readonly key: string;
  readonly version: string;
  readonly applicationType: string;
  readonly name: string;
  readonly description: string;
  readonly language: string;
  readonly framework: string;
  readonly runtime: {
    readonly port: number;
    readonly livenessPath: string;
    readonly readinessPath: string;
    readonly resources: { readonly cpu: string; readonly memory: string };
    readonly configuration: string;
  };
  readonly telemetry: string;
  readonly pipeline: string;
  readonly strategies: readonly string[];
}

export interface BlueprintFile {
  readonly path: string;
  readonly content: Buffer;
}

/** The values a scaffold is filled in with. */
export interface ScaffoldValues {
  readonly name: string;
  readonly slug: string;
}

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STRATEGIES = new Set(['recreate', 'rolling', 'blue-green', 'canary', 'a-b']);
const PLACEHOLDER = /__APP_[A-Z_]+__/g;
const PLACEHOLDERS = new Set(['__APP_NAME__', '__APP_NAME_HTML__', '__APP_NAME_JSON__', '__APP_SLUG__']);

export class InvalidBlueprintError extends Error {
  constructor(where: string, problem: string) {
    super(`Blueprint ${where}: ${problem}`);
    this.name = 'InvalidBlueprintError';
  }
}

/** Checks a manifest's shape, so a broken blueprint stops the API at startup instead of later. */
export function parseManifest(where: string, value: unknown): BlueprintManifest {
  const fail = (problem: string): never => {
    throw new InvalidBlueprintError(where, problem);
  };
  const record = (input: unknown, name: string): Record<string, unknown> =>
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : fail(`${name} must be an object.`);
  const text = (input: Record<string, unknown>, name: string): string => {
    const field = input[name];
    return typeof field === 'string' && field.trim().length > 0 ? field : fail(`${name} must be a non-empty string.`);
  };

  const manifest = record(value, 'The manifest');
  const runtime = record(manifest.runtime, 'runtime');
  const resources = record(runtime.resources, 'runtime.resources');
  const key = text(manifest, 'key');
  const version = text(manifest, 'version');
  if (!KEY_PATTERN.test(key)) {
    fail('key must be lowercase letters, digits and hyphens.');
  }
  if (!VERSION_PATTERN.test(version)) {
    fail('version must be a semantic version, such as 1.0.0.');
  }
  const port = runtime.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    fail('runtime.port must be a port number.');
  }
  const strategies = manifest.strategies;
  if (
    !Array.isArray(strategies) ||
    strategies.length === 0 ||
    !strategies.every((strategy) => typeof strategy === 'string' && STRATEGIES.has(strategy))
  ) {
    fail(`strategies must list some of: ${[...STRATEGIES].join(', ')}.`);
  }
  return {
    key,
    version,
    applicationType: text(manifest, 'applicationType'),
    name: text(manifest, 'name'),
    description: text(manifest, 'description'),
    language: text(manifest, 'language'),
    framework: text(manifest, 'framework'),
    runtime: {
      port: port as number,
      livenessPath: text(runtime, 'livenessPath'),
      readinessPath: text(runtime, 'readinessPath'),
      resources: { cpu: text(resources, 'cpu'), memory: text(resources, 'memory') },
      configuration: text(runtime, 'configuration'),
    },
    telemetry: text(manifest, 'telemetry'),
    pipeline: text(manifest, 'pipeline'),
    strategies: strategies as string[],
  };
}

/** Compares semantic versions, for finding the newest. */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** Text files get placeholders filled in. Anything that isn't UTF-8 text is copied unchanged. */
export function isText(content: Buffer): boolean {
  if (content.includes(0)) {
    return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

/** Finds placeholders the renderer doesn't know, which would end up in a new repository unfilled. */
export function unknownPlaceholders(files: readonly BlueprintFile[]): string[] {
  const unknown = new Set<string>();
  for (const file of files) {
    if (isText(file.content)) {
      for (const match of file.content.toString('utf8').matchAll(PLACEHOLDER)) {
        if (!PLACEHOLDERS.has(match[0])) {
          unknown.add(`${match[0]} in ${file.path}`);
        }
      }
    }
  }
  return [...unknown].sort();
}

/**
 * A fingerprint of a blueprint version: its manifest and every file. Published versions
 * must never change, and this is how that's checked.
 */
export function blueprintChecksum(manifest: Buffer, files: readonly BlueprintFile[]): string {
  const hash = createHash('sha256');
  hash.update(`blueprint.json\n${sha256(manifest)}\n`);
  for (const file of [...files].sort((left, right) => (left.path < right.path ? -1 : 1))) {
    hash.update(`${file.path}\n${sha256(file.content)}\n`);
  }
  return hash.digest('hex');
}

/** Fills in a scaffold. Each placeholder is encoded for where it's used. */
export function renderFiles(files: readonly BlueprintFile[], values: ScaffoldValues): BlueprintFile[] {
  const replacements: Readonly<Record<string, string>> = {
    __APP_NAME__: values.name,
    __APP_NAME_HTML__: escapeHtml(values.name),
    __APP_NAME_JSON__: JSON.stringify(values.name),
    __APP_SLUG__: values.slug,
  };
  return files.map((file) =>
    isText(file.content)
      ? {
          path: file.path,
          content: Buffer.from(
            file.content.toString('utf8').replace(PLACEHOLDER, (token) => replacements[token] ?? token),
            'utf8',
          ),
        }
      : file,
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
