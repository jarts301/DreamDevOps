import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  type BlueprintFile,
  blueprintChecksum,
  type BlueprintManifest,
  compareVersions,
  InvalidBlueprintError,
  parseManifest,
  renderFiles,
  type ScaffoldValues,
  unknownPlaceholders,
} from '../domain/blueprint.ts';
import type { BlueprintCatalog } from '../application/blueprint-catalog.ts';

/** The file that lists every published version and its checksum. */
export const PUBLISHED_FILE = 'published.json';

export interface Blueprint {
  readonly manifest: BlueprintManifest;
  readonly checksum: string;
  readonly files: readonly BlueprintFile[];
}

/**
 * Every blueprint version, read from folders named <key>/<version>. Each holds a
 * blueprint.json and a files folder with the scaffold. A version must be listed in
 * published.json with its checksum, so a published version can never change unnoticed.
 */
export class BlueprintLibrary implements BlueprintCatalog {
  readonly #blueprints: readonly Blueprint[];

  private constructor(blueprints: readonly Blueprint[]) {
    this.#blueprints = blueprints;
  }

  /** Reads and checks every blueprint. Throws if any is broken, changed or unpublished. */
  static load(directory: string): BlueprintLibrary {
    const published = readPublished(directory);
    const blueprints = readBlueprints(directory);
    for (const blueprint of blueprints) {
      const id = `${blueprint.manifest.key}@${blueprint.manifest.version}`;
      const expected = published[id];
      if (expected === undefined) {
        throw new InvalidBlueprintError(id, `it isn't in ${PUBLISHED_FILE}. Publish it before use.`);
      }
      if (expected !== blueprint.checksum) {
        throw new InvalidBlueprintError(id, 'it changed after it was published. Publish a new version instead.');
      }
    }
    for (const id of Object.keys(published)) {
      if (!blueprints.some(({ manifest }) => `${manifest.key}@${manifest.version}` === id)) {
        throw new InvalidBlueprintError(id, `it's in ${PUBLISHED_FILE}, but its folder is missing.`);
      }
    }
    return new BlueprintLibrary(blueprints);
  }

  /** Reads blueprints without checking publication, for the publishing script. */
  static readUnchecked(directory: string): readonly Blueprint[] {
    return readBlueprints(directory);
  }

  /** The newest version of each blueprint. */
  latest(): BlueprintManifest[] {
    const newest = new Map<string, BlueprintManifest>();
    for (const { manifest } of this.#blueprints) {
      const current = newest.get(manifest.key);
      if (current === undefined || compareVersions(manifest.version, current.version) > 0) {
        newest.set(manifest.key, manifest);
      }
    }
    return [...newest.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Every version, newest first within each blueprint. */
  all(): BlueprintManifest[] {
    return this.#blueprints
      .map(({ manifest }) => manifest)
      .sort((left, right) => left.key.localeCompare(right.key) || compareVersions(right.version, left.version));
  }

  /** The newest blueprint for an application type, or null if none exists. */
  latestForType(applicationType: string): BlueprintManifest | null {
    return (
      this.latest()
        .filter((manifest) => manifest.applicationType === applicationType)
        .sort((left, right) => left.key.localeCompare(right.key))[0] ?? null
    );
  }

  /** The scaffold of one version, filled in for an application. */
  render(key: string, version: string, values: ScaffoldValues): BlueprintFile[] {
    const blueprint = this.#blueprints.find(
      ({ manifest }) => manifest.key === key && manifest.version === version,
    );
    if (blueprint === undefined) {
      throw new Error(`Blueprint ${key}@${version} does not exist.`);
    }
    return renderFiles(blueprint.files, values);
  }
}

function readPublished(directory: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(directory, PUBLISHED_FILE), 'utf8')) as Record<string, string>;
  } catch (error) {
    throw new InvalidBlueprintError(PUBLISHED_FILE, `it could not be read: ${String(error)}`);
  }
}

function readBlueprints(directory: string): Blueprint[] {
  const blueprints: Blueprint[] = [];
  for (const key of subfolders(directory)) {
    for (const version of subfolders(join(directory, key))) {
      const folder = join(directory, key, version);
      const where = `${key}/${version}`;
      const manifestContent = readFileSync(join(folder, 'blueprint.json'));
      const manifest = parseManifest(where, JSON.parse(manifestContent.toString('utf8')));
      if (manifest.key !== key || manifest.version !== version) {
        throw new InvalidBlueprintError(where, 'its key and version must match its folder names.');
      }
      const files = readFiles(join(folder, 'files'));
      if (!files.some((file) => file.path === manifest.pipeline)) {
        throw new InvalidBlueprintError(where, `its pipeline file ${manifest.pipeline} is missing.`);
      }
      const unknown = unknownPlaceholders(files);
      if (unknown.length > 0) {
        throw new InvalidBlueprintError(where, `it has unknown placeholders: ${unknown.join(', ')}.`);
      }
      blueprints.push({ manifest, files, checksum: blueprintChecksum(manifestContent, files) });
    }
  }
  return blueprints;
}

function subfolders(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Every file below a folder, with paths written with forward slashes. */
function readFiles(root: string): BlueprintFile[] {
  const files: BlueprintFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push({ path: relative(root, path).split(sep).join('/'), content: readFileSync(path) });
      }
    }
  };
  visit(root);
  return files.sort((left, right) => (left.path < right.path ? -1 : 1));
}
