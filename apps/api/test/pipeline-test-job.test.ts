import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadPipelines } from '../src/builds/infrastructure/pipeline-files.ts';

// Runs the platform's test job, as the pipelines hold it, with sh -e as Forgejo runs every
// step, on small projects. The tools it calls, such as apk, Cargo, pip and wget, are
// stand-ins that record what they're asked and fail when told, so it needs no network,
// no Docker and no language's tools. It needs a POSIX shell, which Windows lacks.

const PIPELINES = fileURLToPath(new URL('../../../pipelines', import.meta.url));
const WORKFLOWS = ['build.yaml', 'check.yaml'] as const;

/** Stand-ins for the tools the job calls. Each records its arguments, one line per call. */
const TOOLS: Readonly<Record<string, string>> = {
  // Sends what a job posts to where the test can read it, and nothing for the source, which is already there.
  wget: `echo "wget $*" >> "$ROOT/calls"
previous=""
for argument in "$@"; do
  if [ "$previous" = "--post-file" ]; then cp "$argument" "$ROOT/posted-$(ls "$ROOT" | grep -c posted-)"; fi
  previous="$argument"
done`,
  tar: 'cat > /dev/null',
  sleep: 'echo "sleep $*" >> "$ROOT/calls"',
  // Fails as many times as its file of failures says, then works, as a download after the network recovers.
  apk: 'echo "apk $*" >> "$ROOT/calls"; fail apk',
  cargo: `echo "cargo $* (multiplexing: \${CARGO_HTTP_MULTIPLEXING:-on}, retries: \${CARGO_NET_RETRY:-default})" >> "$ROOT/calls"
if [ "$1" = fetch ]; then fail cargo-fetch; else echo "test result: $TEST_RESULT"; [ "$TEST_RESULT" = ok ]; fi`,
  python3: `echo "python3 $*" >> "$ROOT/calls"
mkdir -p "$3/bin"
printf '#!/bin/sh\\necho "pip $*" >> "$ROOT/calls"; fail pip\\n' > "$3/bin/pip"
printf '#!/bin/sh\\necho "pytest $*" >> "$ROOT/calls"; echo "1 failed"; [ "$TEST_RESULT" = ok ]\\n' > "$3/bin/pytest"
chmod +x "$3/bin/pip" "$3/bin/pytest"`,
  npm: `echo "npm $*" >> "$ROOT/calls"; if [ "$1" = ci ]; then fail npm-ci; else [ "$TEST_RESULT" = ok ]; fi`,
  // Fails while the named file says failures remain, counting down.
  fail: `left=$(cat "$ROOT/failures-$1" 2>/dev/null || echo 0)
if [ "$left" -gt 0 ]; then echo $((left - 1)) > "$ROOT/failures-$1"; echo "$1: network unreachable"; exit 1; fi`,
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface JobRun {
  readonly exitCode: number | null;
  readonly calls: string[];
  /** What the job posted, in order, such as the tests' log. */
  readonly posted: string[];
}

/**
 * Runs a workflow's test job on a project made of these files. Its paths under /tmp are
 * moved into a folder of the test's own, so runs don't share anything.
 */
function runTestJob(
  workflow: (typeof WORKFLOWS)[number],
  files: Readonly<Record<string, string>>,
  options: { readonly testsPass?: boolean; readonly failures?: Readonly<Record<string, number>> } = {},
): JobRun {
  const root = mkdtempSync(join(tmpdir(), 'test-job-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const [name, script] of Object.entries(TOOLS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  mkdirSync(join(root, 'source'));
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(root, 'source', path), content);
  }
  for (const [tool, count] of Object.entries(options.failures ?? {})) {
    writeFileSync(join(root, `failures-${tool}`), String(count));
  }
  const step = (parse(loadPipelines(PIPELINES, 'test-image-runner')[workflow]) as { jobs: { test: { steps: { run: string }[] } } }).jobs
    .test.steps[0]!.run;
  const result = spawnSync('sh', ['-e', '-c', step.replaceAll('/tmp/', `${root}/`)], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      ROOT: root,
      BUILD_URL: 'http://api.test/api/v1/pipeline/builds/b1',
      BUILD_TOKEN: 'token',
      TEST_RESULT: options.testsPass === false ? 'FAILED' : 'ok',
    },
  });
  const read = (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : '');
  const posted = readdirSync(root)
    .filter((name) => name.startsWith('posted-'))
    .sort()
    .map(read);
  return { exitCode: result.status, calls: read('calls').trim().split('\n'), posted };
}

const rust = { 'Cargo.toml': '[package]\nname = "service"\n', 'Cargo.lock': '' };
const python = { 'pyproject.toml': '[project]\nname = "service"\n', 'requirements-dev.txt': 'pytest==9.2.0\n' };
const javascript = { 'package.json': '{}' };

describe.skipIf(process.platform === 'win32').each(WORKFLOWS)("the platform's test job, in %s", (workflow) => {
  it('sends the log of failing tests, and then fails', () => {
    const run = runTestJob(workflow, rust, { testsPass: false });

    expect(run.exitCode).not.toBe(0);
    expect(run.calls).toContainEqual(expect.stringMatching(/^wget .*--post-file \S+tests-tail\.log \S+\/reports\/tests\?passed=false$/));
    expect(run.posted.at(-1)).toContain('test result: FAILED');
  });

  it('sends the log of passing tests, and passes', () => {
    const run = runTestJob(workflow, rust);

    expect(run.exitCode).toBe(0);
    expect(run.calls.at(-1)).toMatch(/\/reports\/tests\?passed=true$/);
    expect(run.posted.at(-1)).toContain('test result: ok');
  });

  it("downloads Rust's crates on their own, one connection at a time, then tests without the network", () => {
    const run = runTestJob(workflow, rust, { failures: { apk: 1, 'cargo-fetch': 2 } });

    expect(run.exitCode).toBe(0);
    expect(run.calls.filter((call) => !call.startsWith('wget'))).toEqual([
      'apk add --no-cache cargo gcc musl-dev',
      'sleep 15',
      'apk add --no-cache cargo gcc musl-dev',
      'cargo fetch --locked (multiplexing: false, retries: 10)',
      'sleep 15',
      'cargo fetch --locked (multiplexing: false, retries: 10)',
      'sleep 15',
      'cargo fetch --locked (multiplexing: false, retries: 10)',
      'cargo test --locked --offline (multiplexing: false, retries: 10)',
    ]);
  });

  it("tries Python's packages again, with time for slow downloads, but never the tests", () => {
    const run = runTestJob(workflow, python, { testsPass: false, failures: { pip: 1 } });

    expect(run.exitCode).not.toBe(0);
    const pip = 'pip install --timeout 120 --retries 10 --require-hashes --only-binary=:all: -r requirements-dev.txt';
    expect(run.calls.filter((call) => !call.startsWith('wget') && !call.startsWith('apk') && !call.startsWith('python3'))).toEqual([
      pip,
      'sleep 15',
      pip,
      'pytest ',
    ]);
    expect(run.posted.at(-1)).toContain('1 failed');
  });

  it('gives up on a download after three tries, and says so in the log', () => {
    const run = runTestJob(workflow, javascript, { failures: { 'npm-ci': 3 } });

    expect(run.exitCode).not.toBe(0);
    expect(run.calls.filter((call) => call.startsWith('npm'))).toEqual(['npm ci', 'npm ci', 'npm ci']);
    expect(run.posted.at(-1)).toContain("The download failed 3 times, so the tests can't run: npm ci");
  });
});
