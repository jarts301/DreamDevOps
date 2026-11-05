import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScaffoldRenderer } from '../../tenancy/application/ports.ts';
import {
  renderScaffoldFile,
  type ScaffoldFile,
  ScaffoldTemplateError,
  type ScaffoldVariables,
} from '../domain/scaffold.ts';

/** apps/api/scaffolds, from both src and dist. */
export const SCAFFOLDS_DIRECTORY = fileURLToPath(new URL('../../../scaffolds/', import.meta.url));

/** Left by running a scaffold in place. They never belong in a new repository. */
const SKIPPED = new Set(['node_modules', '.venv', 'dist', '.angular', '__pycache__', '.pytest_cache', '.ruff_cache', 'coverage']);

/** Renders scaffolds from their folders in apps/api/scaffolds, one folder per scaffold key. */
export class FileScaffoldTemplates implements ScaffoldRenderer {
  readonly #directory: string;

  /** Refuses to start if a scaffold in the catalog has no folder, so no registration can fail on it later. */
  constructor(keys: readonly string[], directory: string = SCAFFOLDS_DIRECTORY) {
    this.#directory = directory;
    const missing = keys.filter((key) => !existsSync(join(directory, key)));
    if (missing.length > 0) {
      throw new Error(`Scaffolds ${missing.join(', ')} have no folder in ${directory}.`);
    }
  }

  has(key: string): boolean {
    return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(key) && existsSync(join(this.#directory, key));
  }

  async render(key: string, variables: ScaffoldVariables): Promise<ScaffoldFile[]> {
    if (!this.has(key)) {
      throw new Error(`There is no scaffold "${key}".`);
    }
    const root = join(this.#directory, key);
    const files: ScaffoldFile[] = [];
    for (const path of await listFiles(root)) {
      const relativePath = relative(root, path).split(sep).join('/');
      files.push({ path: relativePath, content: renderScaffoldFile(relativePath, await readText(path, relativePath), variables) });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

/** Scaffolds are text, so they can be rendered and reviewed. */
async function readText(path: string, relativePath: string): Promise<string> {
  const bytes = await readFile(path);
  const text = bytes.toString('utf8');
  if (text.includes('\u0000') || !Buffer.from(text, 'utf8').equals(bytes)) {
    throw new ScaffoldTemplateError(relativePath, 'isn\'t UTF-8 text. Scaffolds hold only text files, such as SVG images.');
  }
  return text;
}
