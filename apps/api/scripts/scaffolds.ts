// Keeps scaffolds working. Run from apps/api:
//
//   node scripts/scaffolds.ts verify [key...]         Renders each scaffold and runs its type's commands
//   node scripts/scaffolds.ts lock [key...]           Rewrites each scaffold's lockfile from its dependencies
//   node scripts/scaffolds.ts check <type> <folder>   Runs a type's commands in any checkout, such as
//                                                     an application's repository
//
// verify needs npm, uv and Python 3.13. Set VERIFY_DATABASE_URL to a PostgreSQL server that
// may create databases, such as postgres://user:password@localhost:5433/postgres, to also
// run backends' migrations and health checks against a real database.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ApplicationTypeRegistry } from '../src/application-catalog/application/application-type-registry.ts';
import { APPLICATION_TYPE_CATALOG } from '../src/application-catalog/catalog/index.ts';
import type { ApplicationType } from '../src/application-catalog/domain/application-type.ts';
import { FileScaffoldTemplates, SCAFFOLDS_DIRECTORY } from '../src/application-catalog/infrastructure/file-scaffold-templates.ts';

const registry = new ApplicationTypeRegistry(APPLICATION_TYPE_CATALOG);

/**
 * Every character that could break a file the name or description lands in, at the
 * longest a name may be, so no formatter can fit it on one line it was given.
 */
const HOSTILE = {
  name: ('Verify "Q" <b>&</b> \'a\' \\ ü ✓ *stars* __bold__ [x](y) #tag ~~s~~ &copy; {b} ${x} %s ' + '.'.repeat(100)).slice(0, 100),
  description: `Line one with "quotes", <tags> & *stars*.\n- not a list\n> not a quote\n# not a heading\nA backslash \\ and a tab\t.`,
};
const LOCK_SLUG = 'scaffold-lock';
const LOCKFILES = ['package-lock.json', 'uv.lock'];

const [command, ...requested] = process.argv.slice(2);
if (command === 'check') {
  const [typeKey, folder] = requested;
  const type = typeKey === undefined ? undefined : registry.get(typeKey);
  if (type === undefined || folder === undefined || !existsSync(folder)) {
    fail(`Run "check <type> <folder>". Types: ${registry.list().map((candidate) => candidate.key).join(', ')}.`);
  }
  heading(`${folder} as a ${type.name}`);
  await runChecks(type, folder, { strictPort: false });
  console.log('\nEvery step passed.');
  process.exit(0);
}
const keys = requested.length > 0 ? requested : registry.scaffoldKeys();
for (const key of keys) {
  if (registry.scaffold(key) === undefined) {
    fail(`There is no scaffold "${key}". Scaffolds: ${registry.scaffoldKeys().join(', ')}.`);
  }
}
const templates = new FileScaffoldTemplates(keys);

if (command === 'verify') {
  const results: string[] = [];
  for (const key of keys) {
    await verify(key);
    results.push(key);
  }
  console.log(`\nEvery step passed for ${results.join(', ')}.`);
} else if (command === 'lock') {
  for (const key of keys) {
    await lock(key);
  }
} else {
  fail('Run "verify" or "lock", optionally followed by scaffold keys.');
}

async function verify(key: string): Promise<void> {
  const { type } = registry.scaffold(key)!;
  const directory = await renderInto(key, { ...HOSTILE, slug: `verify-${key}` });
  heading(`${key} (${type.name}) in ${directory}`);
  try {
    await runChecks(type, directory, { strictPort: true });
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    console.error(`\nThe files stay in ${directory} for a look.`);
    throw error;
  }
}

/** The type's commands, in the order a pipeline runs them. */
async function runChecks(type: ApplicationType, directory: string, options: { strictPort: boolean }): Promise<void> {
  {
    const steps: [string, string | undefined][] = [
      ['install', type.commands.install],
      ['lint', type.commands.lint],
      ['format', await formatCheck(directory)],
      ['test', type.commands.test],
      ['build', type.commands.build],
    ];
    for (const [step, shellCommand] of steps) {
      if (shellCommand !== undefined) {
        await run(step, shellCommand, directory);
      }
    }

    const database = type.commands.migrate === undefined ? undefined : await migrate(type, directory);
    await serve(type, directory, database, options.strictPort);
  }
}

/** Without a database there's nothing to migrate, and with one, migrating twice changes nothing. */
async function migrate(type: ApplicationType, directory: string): Promise<string | undefined> {
  await run('migrate, with no database', type.commands.migrate!, directory, { DATABASE_URL: '' });
  const server = process.env['VERIFY_DATABASE_URL'];
  if (server === undefined || server === '') {
    console.log('  Skipped migrating a real database, because VERIFY_DATABASE_URL isn\'t set.');
    return undefined;
  }
  const database = `verify_${randomBytes(4).toString('hex')}`;
  // The command names the variable rather than its value, so no password reaches the output.
  await run('create a database', `psql "$VERIFY_DATABASE_URL" -qc "CREATE DATABASE ${database}"`, directory);
  const url = new URL(server);
  url.pathname = `/${database}`;
  await run('migrate', type.commands.migrate!, directory, { DATABASE_URL: url.toString() });
  await run('migrate again, which changes nothing', type.commands.migrate!, directory, { DATABASE_URL: url.toString() });
  return url.toString();
}

async function serve(
  type: ApplicationType,
  directory: string,
  databaseUrl: string | undefined,
  strictPort: boolean,
): Promise<void> {
  if (type.serving.kind === 'static') {
    const index = join(directory, type.serving.directory, 'index.html');
    if (!existsSync(index)) {
      fail(`The build made no ${type.serving.directory}/index.html.`);
    }
    console.log(`  ✓ serve: the build made ${type.serving.directory}/index.html`);
    return;
  }

  // The type's port is part of its contract, so the process must use it when nothing says otherwise.
  const { healthCheckPath } = type.serving;
  let port = type.serving.port;
  let portSetting = '';
  if (!(await isFree(port))) {
    if (strictPort) {
      fail(`Port ${port} is in use, and the check needs it to prove the app listens there by default.`);
    }
    port = await freePort();
    portSetting = String(port);
    console.log(`  Port ${type.serving.port} is in use, so the app gets PORT=${port}.`);
  }
  const env = { ...process.env, PORT: portSetting, DATABASE_URL: databaseUrl ?? '' };
  const child = spawn('sh', ['-c', type.commands.start!], { cwd: directory, env, detached: true, stdio: 'pipe' });
  let output = '';
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));
  try {
    const body = await waitForHealth(`http://127.0.0.1:${port}${healthCheckPath}`, child);
    console.log(`  ✓ start: answers ${healthCheckPath} on port ${port}${body ? ` with ${body}` : ''}`);
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    stop(child);
  }
}

async function waitForHealth(url: string, child: ChildProcess): Promise<string> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail(`The app stopped with code ${child.exitCode} before answering ${url}.`);
    }
    try {
      const response = await fetch(url);
      if (response.status === 200) {
        const text = await response.text();
        return response.headers.get('content-type')?.includes('json') ? text : '';
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return fail(`Nothing answered 200 at ${url} within 90 seconds.`);
}

function stop(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, 'SIGTERM');
  } catch {
    // Already stopped.
  }
}

/** Scaffolds pass their own formatter too, though the type doesn't ask for it. */
async function formatCheck(directory: string): Promise<string | undefined> {
  if (existsSync(join(directory, 'package.json'))) {
    const { scripts } = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    return scripts?.['format:check'] === undefined ? undefined : 'npm run format:check';
  }
  return existsSync(join(directory, 'pyproject.toml')) ? 'uv run ruff format --check .' : undefined;
}

async function lock(key: string): Promise<void> {
  const directory = await renderInto(key, { name: 'Lock', description: 'Lock', slug: LOCK_SLUG });
  heading(`${key}: writing its lockfile`);
  const root = join(SCAFFOLDS_DIRECTORY, key);
  let written = 0;
  if (existsSync(join(root, 'package.json'))) {
    await rm(join(directory, 'package-lock.json'), { force: true });
    await run('npm', 'npm install --package-lock-only --ignore-scripts --no-audit --no-fund', directory);
  }
  if (existsSync(join(root, 'pyproject.toml'))) {
    await rm(join(directory, 'uv.lock'), { force: true });
    await run('uv', 'uv lock', directory);
  }
  for (const file of LOCKFILES) {
    if (existsSync(join(directory, file))) {
      const content = (await readFile(join(directory, file), 'utf8')).replaceAll(LOCK_SLUG, '__APP_SLUG__');
      await writeFile(join(root, file), content);
      written += 1;
      console.log(`  ✓ wrote scaffolds/${key}/${file}`);
    }
  }
  if (written === 0) {
    fail(`Scaffold "${key}" has no package.json or pyproject.toml to lock.`);
  }
  await rm(directory, { recursive: true, force: true });
}

async function renderInto(key: string, variables: { name: string; slug: string; description: string }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `scaffold-${key}-`));
  for (const file of await templates.render(key, variables)) {
    await mkdir(dirname(join(directory, file.path)), { recursive: true });
    await writeFile(join(directory, file.path), file.content);
  }
  return directory;
}

function run(step: string, shellCommand: string, cwd: string, extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn('sh', ['-c', shellCommand], {
      cwd,
      env: { ...process.env, CI: 'true', NG_CLI_ANALYTICS: 'false', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`  ✓ ${step}: ${shellCommand} (${seconds}s)`);
        resolve();
      } else {
        console.error(`  ✗ ${step}: ${shellCommand} exited with ${code}\n${output}`);
        reject(new Error(`${step} failed.`));
      }
    });
  });
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '0.0.0.0', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function heading(text: string): void {
  console.log(`\n${text}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
