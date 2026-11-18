import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What the contracts may depend on. They're what every part of the platform shares, so
 * they can't depend on any part: the API, its contexts, the dashboard or the agent. And the
 * files browser apps read, each context's http.ts and what it imports, must run in a
 * browser, with nothing from Node and no package at all.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src');
const repository = resolve(root, '..', '..');

/** The packages contract files may use: the shared kernel, and Zod for event payloads. */
const ALLOWED_PACKAGES = ['@dreamdevops/shared-kernel', 'zod'];

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'|import\('([^']+)'\)/g;

function filesUnder(folder: string, suffix: string): string[] {
  return readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => join(entry.parentPath, entry.name));
}

function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(IMPORT)].map((match) => match[1] ?? match[2]!);
}

/** The contract files a file imports, and every file they import in turn. */
function closure(file: string, seen = new Set<string>()): Set<string> {
  if (!seen.has(file)) {
    seen.add(file);
    for (const specifier of importsOf(file).filter((value) => value.startsWith('.'))) {
      closure(resolve(dirname(file), specifier), seen);
    }
  }
  return seen;
}

/** The package and Node imports of a file, and why they keep it out of a browser. */
function browserProblems(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const packages = importsOf(file)
    .filter((specifier) => !specifier.startsWith('.'))
    .map((specifier) => `imports ${specifier}`);
  const nodeGlobals = /\b(Buffer|process)\b/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')) ? ['uses a Node global'] : [];
  return [...packages, ...nodeGlobals];
}

/** A path as the messages show it, with forward slashes on every operating system. */
const posix = (path: string) => path.split(sep).join('/');
const name = (file: string) => posix(relative(source, file));

/** Whether a path is inside a folder. Paths are compared as the system writes them, never by their slashes. */
const isInside = (folder: string, path: string) => {
  const from = relative(folder, path);
  return from !== '' && !from.startsWith('..') && !isAbsolute(from);
};

describe('the contracts', () => {
  const files = filesUnder(source, '.ts');

  it('depend only on each other, the shared kernel and Zod', () => {
    const outside = files.flatMap((file) =>
      importsOf(file)
        .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'))
        .filter((specifier) => !ALLOWED_PACKAGES.some((allowed) => specifier === allowed || specifier.startsWith(`${allowed}/`)))
        .map((specifier) => `${name(file)} imports ${specifier}`),
    );
    const intoApps = files.flatMap((file) =>
      importsOf(file)
        .filter((specifier) => specifier.startsWith('.') && !isInside(source, resolve(dirname(file), specifier)))
        .map((specifier) => `${name(file)} imports ${specifier}`),
    );

    expect([...outside, ...intoApps]).toEqual([]);
  });

  it("keep every context's HTTP contract fit for a browser, with all it imports", () => {
    const httpFiles = files.filter((file) => basename(file) === 'http.ts');
    const problems = httpFiles.flatMap((file) =>
      [...closure(file)].flatMap((reached) => browserProblems(reached).map((problem) => `${name(reached)}, reached from ${name(file)}, ${problem}`)),
    );

    expect(httpFiles.length).toBeGreaterThan(10);
    expect(problems).toEqual([]);
  });

  it('give the dashboard only files fit for a browser', () => {
    const dashboard = join(repository, 'apps', 'dashboard', 'src');
    const used = new Set(
      filesUnder(dashboard, '.ts').flatMap((file) =>
        importsOf(file)
          .filter((specifier) => specifier.startsWith('@dreamdevops/contracts/'))
          .map((specifier) => join(source, `${specifier.slice('@dreamdevops/contracts/'.length)}.ts`)),
      ),
    );
    const reached = new Set([...used].flatMap((file) => [...closure(file)]));
    const problems = [...reached].flatMap((file) => browserProblems(file).map((problem) => `${name(file)} ${problem}`));

    expect(used.size).toBeGreaterThan(5);
    expect(problems).toEqual([]);
  });

  it('give the agent types only, so its image needs nothing but its own code', () => {
    const agent = join(repository, 'apps', 'agent', 'src');
    const valueImports = filesUnder(agent, '.ts').flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/(?:^|\n)\s*import\s+(?!type\b)[^'"]*?from\s+'(@dreamdevops\/contracts\/[^']+)'/g)].map(
        (match) => `${posix(relative(agent, file))} imports values from ${match[1]}`,
      ),
    );

    expect(valueImports).toEqual([]);
  });
});
