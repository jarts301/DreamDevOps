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
    expect(library.latestForType('restful-service')?.key).toBe('node-service');
    expect(library.latestForType('web-frontend')?.key).toBe('angular-frontend');
    for (const manifest of library.latest()) {
      expect(manifest.pipeline).toBe('.forgejo/workflows/ci.yaml');
      expect(manifest.runtime.port).toBe(8080);
      expect(manifest.strategies).toHaveLength(5);
    }
  });

  it('pin base images by digest and run as a non-root user', () => {
    for (const manifest of library.latest()) {
      const files = library.render(manifest.key, manifest.version, { name: 'Probe', slug: 'probe' });
      const dockerfile = files.find((candidate) => candidate.path === 'Dockerfile')!.content.toString();
      for (const line of dockerfile.split('\n').filter((candidate) => candidate.startsWith('FROM '))) {
        expect(line).toMatch(/@sha256:[0-9a-f]{64}/);
      }
      expect(files.some((candidate) => candidate.path === 'package-lock.json')).toBe(true);
      expect(files.some((candidate) => candidate.path === '.dockerignore')).toBe(true);
      expect(files.some((candidate) => candidate.path === 'compose.yaml')).toBe(true);
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
    // Services also measure every request, which gives requests, response times and errors.
    const service = library.latestForType('restful-service')!;
    const telemetry = library
      .render(service.key, service.version, { name: 'Probe', slug: 'probe' })
      .find((candidate) => candidate.path === 'src/telemetry.ts')!
      .content.toString();
    expect(telemetry).toContain('new HttpInstrumentation(');
  });

  it('log in JSON with the trace each line belongs to, and pass traces on to the applications they call', () => {
    const render = (type: string) => {
      const manifest = library.latestForType(type)!;
      const files = library.render(manifest.key, manifest.version, { name: 'Probe', slug: 'probe' });
      return (path: string) => files.find((candidate) => candidate.path === path)!.content.toString();
    };
    const service = render('restful-service');
    expect(service('src/app.ts')).toContain('mixin: currentTraceFields');
    expect(service('src/app.ts')).toContain("'/api/ping'");
    expect(service('src/telemetry.ts')).toContain('new UndiciInstrumentation()');
    expect(service('src/config.ts')).toContain('CORS_ORIGINS');
    const frontend = render('web-frontend');
    expect(frontend('nginx/default.conf')).toMatch(/log_format json escape=json/);
    expect(frontend('nginx/default.conf')).toContain('access_log /var/log/nginx/access.log json;');
    expect(frontend('src/app/app.config.ts')).toContain('withInterceptors([traceContextInterceptor])');
  });

  it('start the frontend’s metrics with nginx, which runs every script in its entrypoint folder', () => {
    const frontend = library.latestForType('web-frontend')!;
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
    expect(library.forType('restful-service').map((manifest) => manifest.key)).toEqual(['node-service']);
    expect(library.forType('mobile-app')).toEqual([]);
    // Applications that choose nothing start from the first by key, as they always have.
    expect(library.latestForType('web-frontend')?.key).toBe('angular-frontend');
    expect(library.latestOf('vue-typescript-frontend')).toMatchObject({ version: '1.0.1', language: 'TypeScript' });
    expect(library.latestOf('cobol-frontend')).toBeNull();
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

  it('give every scaffold the checks the pipeline runs: lint, typecheck, test and build', () => {
    for (const manifest of library.latest()) {
      const file = render(manifest);
      const packageJson = JSON.parse(file('package.json')) as { scripts: Record<string, string> };
      expect(Object.keys(packageJson.scripts), manifest.key).toEqual(expect.arrayContaining(['lint', 'typecheck', 'test', 'build']));
      for (const step of ['npm ci', 'npm run lint', 'npm run typecheck', 'npm test', 'npm run build']) {
        expect(file('.forgejo/workflows/ci.yaml'), `${manifest.key} ${step}`).toContain(`- run: ${step}`);
      }
    }
  });

  it('lock every platform’s native packages, so images build on Alpine, and people build on any computer', () => {
    for (const manifest of library.latest()) {
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

describe('the blueprint library', () => {
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
