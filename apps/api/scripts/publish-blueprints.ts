// Records the checksum of every new blueprint version in blueprints/published.json.
// A published version can't be changed: this refuses, and the API won't start with it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlueprintLibrary, PUBLISHED_FILE } from '../src/blueprints/infrastructure/blueprint-library.ts';

const directory = fileURLToPath(new URL('../../../blueprints', import.meta.url));
const path = join(directory, PUBLISHED_FILE);

let published: Record<string, string> = {};
try {
  published = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
} catch {
  // No versions are published yet.
}

const added: string[] = [];
for (const { manifest, checksum } of BlueprintLibrary.readUnchecked(directory)) {
  const id = `${manifest.key}@${manifest.version}`;
  const existing = published[id];
  if (existing === undefined) {
    published[id] = checksum;
    added.push(id);
  } else if (existing !== checksum) {
    console.error(`${id} changed after it was published. Undo the change and publish a new version instead.`);
    process.exit(1);
  }
}

const sorted = Object.fromEntries(Object.entries(published).sort(([left], [right]) => left.localeCompare(right)));
writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(added.length === 0 ? 'Nothing new to publish.' : `Published: ${added.join(', ')}`);
