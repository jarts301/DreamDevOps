import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { BlueprintLibrary } from '../src/blueprints/infrastructure/blueprint-library.ts';

// Checks that every blueprint version produces a project that installs, passes its own
// checks, builds an image, and starts healthy as a read-only, non-root container.
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

afterAll(() => {
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
    const container = run(
      'docker',
      ['run', '-d', '--rm', '--read-only', '--tmpfs', '/tmp', '-p', `127.0.0.1::${manifest.runtime.port}`, image],
      folder,
    );
    try {
      const address = run('docker', ['port', container, String(manifest.runtime.port)], folder).split('\n')[0]!;
      const base = `http://${address}`;
      expect(await waitForHealth(`${base}${manifest.runtime.livenessPath}`)).toBe(200);
      expect((await fetch(`${base}${manifest.runtime.readinessPath}`)).status).toBe(200);
      const user = run('docker', ['exec', container, 'id', '-u'], folder);
      expect(user).not.toBe('0');
    } finally {
      spawnSync('docker', ['rm', '-f', container]);
      spawnSync('docker', ['rmi', '-f', image]);
    }
  }, 900_000);
});
