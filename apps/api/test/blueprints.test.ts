import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareVersions,
  parseManifest,
  renderFiles,
  unknownPlaceholders,
} from '../src/blueprints/domain/blueprint.ts';
import { BlueprintLibrary } from '../src/blueprints/infrastructure/blueprint-library.ts';
import { parseDockerfile } from '../src/builds/domain/dockerfile-policy.ts';
import { GIT_FLOW, planTeamChanges, teamFor, type TeamKey } from '../src/source-governance/domain/git-flow.ts';
import { pipelineOf } from './support/pipeline.ts';

const BLUEPRINTS = fileURLToPath(new URL('../../../blueprints', import.meta.url));
const file = (path: string, content: string) => ({ path, content: Buffer.from(content) });

describe('the published blueprints', () => {
  const library = BlueprintLibrary.load(BLUEPRINTS);
  /** A blueprint's files, filled in for an application called Probe, by path. */
  const render = (manifest: { key: string; version: string }) => {
    const files = library.render(manifest.key, manifest.version, { name: 'Probe', slug: 'probe' });
    return (path: string) => files.find((candidate) => candidate.path === path)!.content.toString();
  };

  it('cover both starter types, each with a pipeline, health checks and all five strategies', () => {
    expect(library.forType('restful-service')).not.toEqual([]);
    expect(library.forType('web-frontend')).not.toEqual([]);
    for (const manifest of library.latest()) {
      expect(manifest.pipeline).toBe('.forgejo/workflows/ci.yaml');
      expect(manifest.runtime.port).toBe(8080);
      expect(manifest.strategies).toHaveLength(5);
    }
  });

  it('pin base images by digest, lock their dependencies, and run as a non-root user', () => {
    for (const manifest of library.latest()) {
      const files = library.render(manifest.key, manifest.version, { name: 'Probe', slug: 'probe' });
      const dockerfile = files.find((candidate) => candidate.path === 'Dockerfile')!.content.toString();
      for (const line of dockerfile.split('\n').filter((candidate) => candidate.startsWith('FROM '))) {
        expect(line).toMatch(/@sha256:[0-9a-f]{64}/);
      }
      // Each language locks its dependencies in its own way, and the pipeline runs in the image the Dockerfile builds on.
      const lockfiles = ['package-lock.json', 'requirements.txt', 'Cargo.lock', 'third_party/SHA256SUMS'];
      expect(files.filter((candidate) => lockfiles.includes(candidate.path)), manifest.key).toHaveLength(1);
      expect(files.some((candidate) => candidate.path === '.dockerignore')).toBe(true);
      expect(files.some((candidate) => candidate.path === 'compose.yaml')).toBe(true);
      const workflow = files.find((candidate) => candidate.path === manifest.pipeline)!.content.toString();
      expect(dockerfile, manifest.key).toContain(`FROM ${pipelineOf(workflow).image}`);
    }
  });

  it('apply the security fixes released since their base images, and still run as a non-root user', () => {
    for (const manifest of library.latest()) {
      const files = library.render(manifest.key, manifest.version, { name: 'Probe', slug: 'probe' });
      const instructions = parseDockerfile(files.find((candidate) => candidate.path === 'Dockerfile')!.content.toString());
      // Only the last stage ends up in the image, so that's where the fixes must be.
      const lastStage = instructions.slice(instructions.findLastIndex((instruction) => instruction.keyword === 'FROM'));
      const upgrade = lastStage.findIndex((instruction) => instruction.keyword === 'RUN' && instruction.args === 'apk upgrade --no-cache');
      expect(upgrade, manifest.key).toBeGreaterThan(0);
      const user = lastStage.findLast((instruction) => instruction.keyword === 'USER');
      expect(user, manifest.key).toBeDefined();
      expect(lastStage.indexOf(user!), manifest.key).toBeGreaterThan(upgrade);
      expect(['root', '0'], manifest.key).not.toContain(user!.args);
    }
  });

  it('send the metrics Monitoring shows, by their standard names, when the platform says where', () => {
    for (const manifest of library.latest()) {
      const files = library.render(manifest.key, manifest.version, { name: 'Probe', slug: 'probe' });
      const text = files.map((candidate) => candidate.content.toString()).join('\n');
      for (const expected of ['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'process.cpu.time', 'process.memory.usage']) {
        expect(text, `${manifest.key} ${expected}`).toContain(expected);
      }
      expect(manifest.telemetry, manifest.key).toMatch(/CPU.* memory/);
    }
    // Services also measure every request, which gives requests, response times and errors:
    // with OpenTelemetry's instrumentation of HTTP or of their framework, or by themselves.
    for (const manifest of library.forType('restful-service')) {
      const files = library.render(manifest.key, manifest.version, { name: 'Probe', slug: 'probe' });
      const code = files
        .filter((candidate) => /^(src|service)\//.test(candidate.path))
        .map((candidate) => candidate.content.toString())
        .join('\n');
      expect(code, manifest.key).toMatch(/new HttpInstrumentation\(|Instrumentor\b|"http\.server\.request\.duration"/);
    }
  });

  it('log in JSON with the trace each line belongs to, and pass traces on to the applications they call', () => {
    const service = render(library.latestOf('node-service')!);
    expect(service('src/app.ts')).toContain('mixin: currentTraceFields');
    expect(service('src/app.ts')).toContain("'/api/ping'");
    expect(service('src/telemetry.ts')).toContain('new UndiciInstrumentation()');
    expect(service('src/config.ts')).toContain('CORS_ORIGINS');
    const frontend = render(library.latestOf('angular-frontend')!);
    expect(frontend('nginx/default.conf')).toMatch(/log_format json escape=json/);
    expect(frontend('nginx/default.conf')).toContain('access_log /var/log/nginx/access.log json;');
    expect(frontend('src/app/app.config.ts')).toContain('withInterceptors([traceContextInterceptor])');
  });

  it('start the frontend’s metrics with nginx, which runs every script in its entrypoint folder', () => {
    const frontend = library.latestOf('angular-frontend')!;
    const files = library.render(frontend.key, frontend.version, { name: 'Probe', slug: 'probe' });
    const instructions = parseDockerfile(files.find((candidate) => candidate.path === 'Dockerfile')!.content.toString());

    expect(instructions).toContainEqual(
      expect.objectContaining({ keyword: 'COPY', args: '--chmod=0755 nginx/send-metrics.sh /docker-entrypoint.d/50-send-metrics.sh' }),
    );
    expect(files.find((candidate) => candidate.path === 'nginx/send-metrics.sh')!.content.toString()).toMatch(/^#!\/bin\/sh\n/);
  });

  it('offer web frontends in TypeScript, JavaScript and Python, each on a popular open-source framework', () => {
    expect(library.forType('web-frontend').map((manifest) => `${manifest.language}: ${manifest.framework}`)).toEqual([
      'JavaScript: React 19',
      'JavaScript: Svelte 5',
      'JavaScript: Vue 3',
      'Python: PyScript 0.7, on Pyodide 314',
      'TypeScript: Angular 22',
      'TypeScript: React 19',
      'TypeScript: Svelte 5',
      'TypeScript: Vue 3',
    ]);
    expect(library.forType('mobile-app')).toEqual([]);
    expect(library.latestOf('vue-typescript-frontend')).toMatchObject({ version: '1.0.1', language: 'TypeScript' });
    expect(library.latestOf('cobol-frontend')).toBeNull();
  });

  it('offer RESTful services in TypeScript, JavaScript, Python, Rust and C++, each on a popular open-source framework', () => {
    expect(library.forType('restful-service').map((manifest) => `${manifest.language}: ${manifest.framework}`)).toEqual([
      'C++: cpp-httplib on C++20',
      'JavaScript: Express 5 on Node.js 24',
      'JavaScript: Fastify 5 on Node.js 24',
      'Python: FastAPI on Python 3',
      'Python: Flask 3 on Python 3',
      'Rust: Actix Web 4',
      'Rust: Axum 0.8 on Tokio',
      'TypeScript: Express 5 on Node.js 24',
      'TypeScript: NestJS 12 on Node.js 24',
      'TypeScript: Fastify on Node.js 24',
    ]);
    // Which one an application starts from when none is chosen is the catalog's to say, not the order of keys.
    expect(library.latestForType('restful-service')?.key).not.toBe('node-service');
  });

  it('give every service the same contract: its routes, JSON logs with their trace, and settings from the environment', () => {
    for (const manifest of library.forType('restful-service')) {
      const files = library.render(manifest.key, manifest.version, { name: 'Probe', slug: 'probe' });
      const code = files
        .filter((candidate) => /^(src|service)\//.test(candidate.path))
        .map((candidate) => candidate.content.toString())
        .join('\n');
      // Routes are written whole, such as /api/ping, or in parts, such as NestJS's @Controller('api') and @Get('ping').
      for (const expected of ['health', 'live', 'ready', 'ping', 'hello', 'Ping received', 'CORS_ORIGINS', 'traceparent']) {
        expect(code, `${manifest.key} ${expected}`).toContain(expected);
      }
      expect(code, manifest.key).toMatch(/trace_id|currentTraceFields/);
      const readme = files.find((candidate) => candidate.path === 'README.md')!.content.toString();
      expect(readme, manifest.key).toMatch(/^# Probe\n/);
      expect(readme, manifest.key).toContain('| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` |');
    }
  });

  it('keep only what each service runs with in its image: no npm or Yarn, and no package.json named after the application', () => {
    for (const manifest of library.forType('restful-service')) {
      const instructions = parseDockerfile(render(manifest)('Dockerfile'));
      const lastStage = instructions.slice(instructions.findLastIndex((instruction) => instruction.keyword === 'FROM'));
      const removed = lastStage
        .filter((instruction) => instruction.keyword === 'RUN' && instruction.args.startsWith('rm -rf '))
        .flatMap((instruction) => instruction.args.split(/\s+/));
      // The base image's npm brings packages of its own, such as undici, which scanners report.
      for (const path of ['/usr/local/bin/npm', '/usr/local/bin/npx', '/usr/local/lib/node_modules', '/opt/yarn-*']) {
        expect(removed, `${manifest.key} ${path}`).toContain(path);
      }
      // Services in other languages don't need Node.js itself either.
      expect(removed.includes('/usr/local/bin/node'), manifest.key).toBe(!['TypeScript', 'JavaScript'].includes(manifest.language));
      // An application named like a published package, such as fastify, would be reported with that package's vulnerabilities.
      expect(
        lastStage.some((instruction) => instruction.keyword === 'COPY' && /package(-lock)?\.json/.test(instruction.args)),
        manifest.key,
      ).toBe(false);
    }
  });

  it('give every web frontend the same runtime: JSON request logs, metrics started by nginx, and settings read at startup', () => {
    const angular = render(library.latestOf('angular-frontend')!);
    for (const manifest of library.forType('web-frontend')) {
      const file = render(manifest);
      expect(file('nginx/default.conf'), manifest.key).toContain('access_log /var/log/nginx/access.log json;');
      expect(file('nginx/default.conf'), manifest.key).toContain('location = /healthz');
      for (const shared of ['nginx/send-metrics.sh', 'nginx/write-runtime-config.sh', 'nginx/security-headers.conf', 'compose.yaml']) {
        expect(file(shared), `${manifest.key} ${shared}`).toBe(angular(shared));
      }
      const instructions = parseDockerfile(file('Dockerfile'));
      expect(instructions, manifest.key).toContainEqual(
        expect.objectContaining({ keyword: 'COPY', args: '--chmod=0755 nginx/send-metrics.sh /docker-entrypoint.d/50-send-metrics.sh' }),
      );
      expect(instructions.at(-1), manifest.key).toMatchObject({ keyword: 'HEALTHCHECK' });
    }
  });

  it('log the path each request asked for, without its query string, rather than the file nginx served', () => {
    for (const manifest of library.forType('web-frontend')) {
      const conf = render(manifest)('nginx/default.conf');
      const format = conf.slice(conf.indexOf('log_format json'), conf.indexOf(';', conf.indexOf('log_format json')));
      // nginx's $uri becomes /index.html whenever it serves the app's page, such as for / or /orders/42.
      expect(format, manifest.key).not.toContain('$uri');
      expect(format, manifest.key).toContain('"msg":"$request_method $request_path $status"');
      expect(format, manifest.key).toContain('"path":"$request_path"');
      expect(conf, manifest.key).toContain('map $request_uri $request_path {\n  "~^(?<path>[^?]*)" $path;\n}');
    }
  });

  it('let every web frontend start a trace for its API calls, and ping the API with one', () => {
    for (const manifest of library.forType('web-frontend')) {
      const files = library.render(manifest.key, manifest.version, { name: 'Probe', slug: 'probe' });
      const code = files
        .filter((candidate) => /\.(ts|js|tsx|jsx|vue|svelte|py)$/.test(candidate.path) && !candidate.path.startsWith('scripts/'))
        .map((candidate) => candidate.content.toString())
        .join('\n');
      expect(code, manifest.key).toMatch(/traceparent/);
      expect(code, manifest.key).toMatch(/\/ping/);
      expect(code, manifest.key).toMatch(/Check the API/);
    }
  });

  it('give every scaffold the checks the pipeline runs, in its language: lint, types or warnings, and tests', () => {
    const checks: Readonly<Record<string, readonly string[]>> = {
      'package.json': ['npm ci', 'npm run lint', 'npm run typecheck', 'npm test'],
      'pyproject.toml': [
        '.venv/bin/pip install --require-hashes --only-binary=:all: -r requirements-dev.txt',
        '.venv/bin/ruff check .',
        '.venv/bin/ruff format --check .',
        '.venv/bin/mypy',
        '.venv/bin/pytest',
      ],
      'Cargo.toml': ['cargo fmt --check', 'cargo clippy --locked --all-targets -- -D warnings', 'cargo test --locked'],
      'CMakeLists.txt': [
        'sha256sum -c third_party/SHA256SUMS',
        'cmake -S . -B build -DWARNINGS_AS_ERRORS=ON',
        'cmake --build build --parallel',
        'ctest --test-dir build --output-on-failure',
      ],
    };
    for (const manifest of library.latest()) {
      const files = library.render(manifest.key, manifest.version, { name: 'Probe', slug: 'probe' });
      const project = Object.keys(checks).filter((path) => files.some((candidate) => candidate.path === path));
      expect(project, manifest.key).toHaveLength(1);
      const { steps } = pipelineOf(render(manifest)(manifest.pipeline));
      for (const step of checks[project[0]!]!) {
        expect(steps.some((candidate) => candidate.endsWith(step)), `${manifest.key} ${step}`).toBe(true);
      }
      if (project[0] === 'package.json') {
        const packageJson = JSON.parse(render(manifest)('package.json')) as { scripts: Record<string, string> };
        expect(Object.keys(packageJson.scripts), manifest.key).toEqual(expect.arrayContaining(['lint', 'typecheck', 'test']));
        // What's built, such as TypeScript, is built by the pipeline too. JavaScript services run their sources as they are.
        expect(steps.includes('npm run build'), manifest.key).toBe(packageJson.scripts['build'] !== undefined);
      }
    }
  });

  it('lock Python, Rust and C++ dependencies with their checksums, and install only what was locked', () => {
    const locked = (manifest: { key: string; version: string }, lockfile: string) =>
      library.render(manifest.key, manifest.version, { name: 'Probe', slug: 'probe' }).some((candidate) => candidate.path === lockfile);
    const python = library.latest().filter((manifest) => locked(manifest, 'requirements.txt'));
    const rust = library.latest().filter((manifest) => locked(manifest, 'Cargo.lock'));
    const cpp = library.latest().filter((manifest) => locked(manifest, 'third_party/SHA256SUMS'));
    expect([python, rust, cpp].map((manifests) => manifests.length)).toEqual([2, 2, 1]);

    for (const manifest of python) {
      const file = render(manifest);
      for (const lockfile of ['requirements.txt', 'requirements-dev.txt']) {
        const requirements = file(lockfile).split(/\n(?!\s)/).filter((entry) => /^[a-z0-9]/i.test(entry));
        expect(requirements.length, `${manifest.key} ${lockfile}`).toBeGreaterThan(5);
        for (const requirement of requirements) {
          expect(requirement, `${manifest.key} ${lockfile}`).toMatch(/^\S+==\S+/);
          expect(requirement, `${manifest.key} ${lockfile}`).toMatch(/--hash=sha256:[0-9a-f]{64}/);
        }
      }
      expect(file('Dockerfile'), manifest.key).toContain('--require-hashes --only-binary=:all: -r requirements.txt');
    }
    for (const manifest of rust) {
      const file = render(manifest);
      const packages = file('Cargo.lock').split('[[package]]').slice(1);
      const fromRegistry = packages.filter((entry) => entry.includes('source = "registry+'));
      expect(fromRegistry.length, manifest.key).toBe(packages.length - 1);
      for (const entry of fromRegistry) {
        expect(entry, manifest.key).toMatch(/checksum = "[0-9a-f]{64}"/);
      }
      expect(file('Cargo.toml'), manifest.key).toMatch(/^rust-version = "1\.\d+"$/m);
      expect(file('Dockerfile'), manifest.key).toContain('cargo build --release --locked');
    }
    for (const manifest of cpp) {
      const files = library.render(manifest.key, manifest.version, { name: 'Probe', slug: 'probe' });
      const sums = render(manifest)('third_party/SHA256SUMS').trim().split('\n');
      expect(sums.length, manifest.key).toBeGreaterThan(0);
      for (const line of sums) {
        const [sum, path] = line.split(/\s+/);
        const vendored = files.find((candidate) => candidate.path === path);
        expect(vendored, `${manifest.key} ${path}`).toBeDefined();
        expect(createHash('sha256').update(vendored!.content).digest('hex'), `${manifest.key} ${path}`).toBe(sum);
      }
    }
  });

  it('lock every platform’s native packages, so images build on Alpine, and people build on any computer', () => {
    const npm = library.latest().filter((manifest) =>
      library.render(manifest.key, manifest.version, { name: 'Probe', slug: 'probe' }).some((candidate) => candidate.path === 'package-lock.json'),
    );
    expect(npm.length).toBeGreaterThan(10);
    for (const manifest of npm) {
      const lock = JSON.parse(render(manifest)('package-lock.json')) as {
        packages: Record<string, { optionalDependencies?: Record<string, string>; integrity?: string; link?: boolean }>;
      };
      // Where Node would find a dependency from a package's folder.
      const installed = (from: string, name: string): boolean => {
        for (let base = from; ; base = base.includes('/node_modules/') ? base.slice(0, base.lastIndexOf('/node_modules/')) : '') {
          if (lock.packages[`${base === '' ? '' : `${base}/`}node_modules/${name}`] !== undefined) {
            return true;
          }
          if (base === '') {
            return false;
          }
        }
      };
      const missing = Object.entries(lock.packages).flatMap(([path, entry]) =>
        Object.keys(entry.optionalDependencies ?? {})
          .filter((name) => !installed(path, name))
          .map((name) => `${name} for ${path || 'the project'}`),
      );
      expect(missing, manifest.key).toEqual([]);
      for (const [path, entry] of Object.entries(lock.packages).filter(([path, entry]) => path !== '' && !entry.link)) {
        expect(entry.integrity, `${manifest.key} ${path}`).toMatch(/^sha512-/);
      }
    }
    const vite = JSON.parse(render(library.latestOf('react-typescript-frontend')!)('package-lock.json')) as { packages: object };
    expect(Object.keys(vite.packages)).toEqual(
      expect.arrayContaining(['node_modules/@rolldown/binding-linux-x64-musl', 'node_modules/@rolldown/binding-linux-arm64-musl']),
    );
  });

  it('serve PyScript and Python themselves, from the versions they were tested with, rather than a CDN', () => {
    const file = render(library.latestOf('pyscript-frontend')!);
    const packageJson = JSON.parse(file('package.json')) as { dependencies: Record<string, string> };

    expect(packageJson.dependencies).toEqual({ '@pyscript/core': '0.7.31', pyodide: '314.0.5' });
    expect(file('index.html')).not.toMatch(/https?:\/\//);
    expect(file('index.html')).toContain('<script type="py" src="/main.py" config="/pyscript.json"></script>');
    expect(file('scripts/build.mjs')).toContain('interpreter: `${PYODIDE}/pyodide.mjs`');
    // Browsers only run modules and WebAssembly served with their own types.
    expect(file('nginx/default.conf')).toMatch(/location \^~ \/vendor\/ \{\n    types \{\n      text\/javascript js mjs;/);
    expect(file('nginx/default.conf')).toContain('application/wasm wasm;');
    expect(file('src/app_info.py')).toBe(`"""The application's name, as registered in DreamDevOps."""\n\nAPP_NAME: str = "Probe"\n`);
  });

  it('leave no placeholder unfilled', () => {
    for (const manifest of library.all()) {
      const files = library.render(manifest.key, manifest.version, { name: 'Probe', slug: 'probe' });
      for (const rendered of files) {
        expect(rendered.content.toString()).not.toMatch(/__APP_[A-Z_]+__/);
      }
    }
  });
});

// Each test copies every blueprint, which takes a second or more, and longer on a busy machine.
describe('the blueprint library', { timeout: 30_000 }, () => {
  let copy: string;

  const loadCopy = () => BlueprintLibrary.load(copy);
  const makeCopy = () => {
    copy = mkdtempSync(join(tmpdir(), 'blueprints-'));
    cpSync(BLUEPRINTS, copy, { recursive: true });
  };

  afterEach(() => rmSync(copy, { recursive: true, force: true }));

  it('refuses to start when a published version has changed', () => {
    makeCopy();
    appendFileSync(join(copy, 'node-service/1.0.0/files/src/app.ts'), '\n// changed\n');

    expect(loadCopy).toThrow('node-service@1.0.0: it changed after it was published');
  });

  it('refuses a version that was never published', () => {
    makeCopy();
    cpSync(join(copy, 'node-service/1.0.0'), join(copy, 'node-service/9.9.9'), { recursive: true });
    const manifest = join(copy, 'node-service/9.9.9/blueprint.json');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('"1.0.0"', '"9.9.9"'));

    expect(loadCopy).toThrow("node-service@9.9.9: it isn't in published.json");
  });

  it('refuses a published version whose folder is missing', () => {
    makeCopy();
    rmSync(join(copy, 'angular-frontend'), { recursive: true });

    expect(loadCopy).toThrow("angular-frontend@1.0.0: it's in published.json, but its folder is missing");
  });
});

describe('blueprint manifests', () => {
  const valid = JSON.parse(readFileSync(join(BLUEPRINTS, 'node-service/1.0.0/blueprint.json'), 'utf8')) as object;

  it('accept a complete manifest', () => {
    expect(parseManifest('test', valid)).toMatchObject({ key: 'node-service', runtime: { port: 8080 } });
  });

  it.each([
    [{ version: '1.0' }, 'version must be a semantic version'],
    [{ key: 'Node Service' }, 'key must be lowercase'],
    [{ strategies: ['yolo'] }, 'strategies must list some of'],
    [{ runtime: { port: 0 } }, 'runtime.resources must be an object'],
    [{ name: '' }, 'name must be a non-empty string'],
  ])('refuse %j', (change, message) => {
    expect(() => parseManifest('test', { ...valid, ...change })).toThrow(message);
  });
});

describe('rendering a scaffold', () => {
  const files = [
    file('README.md', '# __APP_NAME__'),
    file('index.html', '<title>__APP_NAME_HTML__</title>'),
    file('info.ts', 'export const NAME = __APP_NAME_JSON__;'),
    file('package.json', '{"name": "__APP_SLUG__"}'),
  ];

  it('encodes each placeholder for where it is used', () => {
    const rendered = renderFiles(files, { name: `Tom's <"Shop"> & co`, slug: 'toms-shop' });
    const text = (path: string) => rendered.find((candidate) => candidate.path === path)!.content.toString();

    expect(text('README.md')).toBe(`# Tom's <"Shop"> & co`);
    expect(text('index.html')).toBe('<title>Tom&#39;s &#60;&#34;Shop&#34;&#62; &#38; co</title>');
    expect(text('info.ts')).toBe('export const NAME = "Tom\'s <\\"Shop\\"> & co";');
    expect(JSON.parse(text('package.json'))).toEqual({ name: 'toms-shop' });
  });

  it('copies binary files unchanged', () => {
    const binary = { path: 'logo.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x5f, 0x5f]) };

    expect(renderFiles([binary], { name: 'X', slug: 'x' })[0]!.content).toEqual(binary.content);
  });

  it('finds placeholders the renderer does not know', () => {
    expect(unknownPlaceholders([file('a.txt', '__APP_SLUG__ __APP_OWNER__')])).toEqual(['__APP_OWNER__ in a.txt']);
  });

  it('compares versions by number, not by text', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });
});

describe('Git Flow', () => {
  it('puts each role in the right team', () => {
    expect(teamFor(['code:push', 'pull-requests:approve', 'releases:start'])).toBe('tech-leads');
    expect(teamFor(['code:push', 'feature-images:build'])).toBe('developers');
    expect(teamFor(['dashboards:view'])).toBe('readers');
    expect(teamFor(['company-users:manage', 'audit:read'])).toBe('readers');
  });

  it('protects main and develop from direct pushes, and leaves feature branches open', () => {
    const patterns = Object.fromEntries(GIT_FLOW.branches.map((rule) => [rule.pattern, rule.directPush]));
    expect(patterns).toEqual({ main: 'nobody', develop: 'nobody', 'release/*': 'platform', 'hotfix/*': 'platform' });
    expect(GIT_FLOW.branches.every((rule) => rule.requiredApprovals >= 1 && rule.approvingTeam === 'tech-leads')).toBe(
      true,
    );
    expect(GIT_FLOW.platformTags).toEqual(['v*']);
  });

  it('plans the fewest team changes, removing people who should not be there', () => {
    const desired = new Map<string, TeamKey>([
      ['ana', 'tech-leads'],
      ['bo', 'developers'],
      ['cy', 'readers'],
    ]);
    const current = new Map<TeamKey, string[]>([
      ['tech-leads', ['ana', 'stranger']],
      ['developers', ['cy']],
      ['readers', []],
    ]);

    expect(planTeamChanges(desired, current)).toEqual({
      add: [
        { team: 'developers', username: 'bo' },
        { team: 'readers', username: 'cy' },
      ],
      remove: [
        { team: 'tech-leads', username: 'stranger' },
        { team: 'developers', username: 'cy' },
      ],
    });
  });
});
