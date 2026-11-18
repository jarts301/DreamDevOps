import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
/** What the package exports, in package.json. Everything else is reached from these. */
const ENTRY_POINTS = ['index.ts', join('postgres', 'index.ts'), join('testing', 'index.ts')];
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+'(\.[^']+)'/g;

describe('the shared kernel', () => {
  it('has no files its exports never reach, such as one left over after a move', () => {
    const files = readdirSync(SRC, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => join(entry.parentPath, entry.name));
    const reached = new Set<string>();
    const stack = ENTRY_POINTS.map((entry) => join(SRC, entry));
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (!reached.has(file)) {
        reached.add(file);
        for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
          stack.push(resolve(dirname(file), match[1]!));
        }
      }
    }
    const unused = files.filter((file) => !reached.has(file)).map((file) => relative(SRC, file).split(sep).join('/'));

    expect(unused, 'Delete these, or export them from where they belong').toEqual([]);
  });
});
