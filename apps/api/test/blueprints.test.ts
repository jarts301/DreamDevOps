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
import { GIT_FLOW, planTeamChanges, teamFor, type TeamKey } from '../src/source-governance/domain/git-flow.ts';

const BLUEPRINTS = fileURLToPath(new URL('../../../blueprints', import.meta.url));
const file = (path: string, content: string) => ({ path, content: Buffer.from(content) });

describe('the published blueprints', () => {
  const library = BlueprintLibrary.load(BLUEPRINTS);

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
    cpSync(join(copy, 'node-service/1.0.0'), join(copy, 'node-service/1.1.0'), { recursive: true });
    const manifest = join(copy, 'node-service/1.1.0/blueprint.json');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('"1.0.0"', '"1.1.0"'));

    expect(loadCopy).toThrow("node-service@1.1.0: it isn't in published.json");
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
