import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApplicationTypeRegistry } from '../src/application-catalog/application/application-type-registry.ts';
import { APPLICATION_TYPE_CATALOG } from '../src/application-catalog/catalog/index.ts';
import { renderScaffoldFile, ScaffoldTemplateError } from '../src/application-catalog/domain/scaffold.ts';
import {
  FileScaffoldTemplates,
  SCAFFOLDS_DIRECTORY,
} from '../src/application-catalog/infrastructure/file-scaffold-templates.ts';

const registry = new ApplicationTypeRegistry(APPLICATION_TYPE_CATALOG);
const templates = new FileScaffoldTemplates(registry.scaffoldKeys());

/** Every character that could break a file a name or description lands in. */
const HOSTILE = {
  name: `Acme "Q" <b>&</b> 'a' \\ ü ✓ *stars* [x](y) #tag \${x} %s {{ x }}`,
  description: 'Line one, "quoted".\n- not a list\n\tand a tab & <tag>',
  slug: 'acme-billing',
};

describe('rendering a scaffold file', () => {
  it('puts the slug anywhere, because it is only letters, digits and hyphens', () => {
    expect(renderScaffoldFile('src/main.ts', 'const app = "__APP_SLUG__";', HOSTILE)).toBe('const app = "acme-billing";');
  });

  it('escapes a name for JSON', () => {
    const rendered = renderScaffoldFile('about.json', '{ "name": "__APP_NAME__", "description": "__APP_DESCRIPTION__" }', HOSTILE);

    expect(JSON.parse(rendered)).toEqual({ name: HOSTILE.name, description: HOSTILE.description });
  });

  it('escapes a name for HTML', () => {
    expect(renderScaffoldFile('index.html', '<title>__APP_NAME__</title>', { ...HOSTILE, name: `"A" <b>&</b> 'c'` })).toBe(
      '<title>&quot;A&quot; &lt;b&gt;&amp;&lt;/b&gt; &#39;c&#39;</title>',
    );
  });

  it('escapes a name for Markdown, so it reads as the text it is', () => {
    expect(renderScaffoldFile('README.md', '# __APP_NAME__', { ...HOSTILE, name: 'A *b* [c](d) #e & f' })).toBe(
      '# A \\*b\\* \\[c\\]\\(d\\) \\#e &amp; f',
    );
  });

  it.each(['src/main.ts', 'src/app/main.py', 'pyproject.toml', 'styles.css', 'Dockerfile'])(
    'refuses a name in %s, where no escaping is exact',
    (path) => {
      expect(() => renderScaffoldFile(path, 'x = "__APP_NAME__"', HOSTILE)).toThrow(ScaffoldTemplateError);
    },
  );

  it('refuses a placeholder it does not know', () => {
    expect(() => renderScaffoldFile('about.json', '"__APP_VERSION__"', HOSTILE)).toThrow("isn't a placeholder");
  });

  it('leaves other template syntax alone, such as Angular and Mako', () => {
    const template = '<p>{{ count() }}</p> ${message} {% block %}';

    expect(renderScaffoldFile('app.html', template, HOSTILE)).toBe(template);
  });
});

describe('the scaffolds folder', () => {
  it('has a folder for every scaffold in the catalog, and nothing else', () => {
    const folders = readdirSync(SCAFFOLDS_DIRECTORY, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(folders).toEqual([...registry.scaffoldKeys()].sort());
  });

  it('refuses to start when a scaffold in the catalog has no folder', () => {
    expect(() => new FileScaffoldTemplates(['angular', 'missing'])).toThrow('Scaffolds missing have no folder');
  });

  it('renders only scaffolds that exist', async () => {
    await expect(templates.render('../angular', HOSTILE)).rejects.toThrow('There is no scaffold');
  });
});

// Checks every scaffold against its type without installing anything. The scaffolds:verify
// script runs the commands themselves.
describe.each(registry.scaffoldKeys().map((key) => [key, registry.scaffold(key)!.type] as const))(
  'the %s scaffold',
  (key, type) => {
    const render = () => templates.render(key, HOSTILE);
    const fileOf = async (path: string) => (await render()).find((file) => file.path === path)?.content;

    it('renders every file, with nothing left to fill in', async () => {
      const files = await render();

      expect(files.length).toBeGreaterThan(5);
      for (const file of files) {
        expect(file.content, file.path).not.toMatch(/__APP_[A-Z]+__/);
      }
    });

    it('has no placeholder a formatter has rewritten, such as __APP_NAME__ read as bold Markdown', () => {
      const mangled: string[] = [];
      const walk = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            walk(path);
          } else if (!/lock/.test(entry.name) && /(?<!__)APP_(NAME|SLUG|DESCRIPTION)|APP_(NAME|SLUG|DESCRIPTION)(?!__)/.test(readFileSync(path, 'utf8'))) {
            mangled.push(path.slice(SCAFFOLDS_DIRECTORY.length));
          }
        }
      };
      walk(join(SCAFFOLDS_DIRECTORY, key));

      expect(mangled).toEqual([]);
    });

    it('opens its README with the name of the application', async () => {
      const readme = (await fileOf('README.md'))!;

      expect(readme.split('\n')[0]).toBe(`# ${renderScaffoldFile('README.md', '__APP_NAME__', HOSTILE)}`);
      expect(readme).toContain(renderScaffoldFile('README.md', '__APP_DESCRIPTION__', HOSTILE));
    });

    it('holds its name and description in about.json', async () => {
      const about = (await render()).find((file) => file.path.endsWith('about.json'));

      expect(JSON.parse(about!.content)).toEqual({ name: HOSTILE.name, description: HOSTILE.description });
    });

    it('has a README, ignores what git should, and holds nothing a run leaves behind', async () => {
      const paths = (await render()).map((file) => file.path);

      expect(paths).toContain('README.md');
      expect(paths).toContain('.gitignore');
      expect(paths.filter((path) => /(^|\/)(node_modules|\.venv|dist|__pycache__)\//.test(path))).toEqual([]);
    });

    it('has tests', async () => {
      const paths = (await render()).map((file) => file.path);

      expect(paths.some((path) => /\.(spec|test|e2e-spec)\.tsx?$|(^|\/)test_[^/]+\.py$/.test(path))).toBe(true);
    });

    if (type.language.key === 'typescript') {
      it("defines an npm script for each of its type's commands", async () => {
        const manifest = JSON.parse((await fileOf('package.json'))!) as { name: string; scripts: Record<string, string> };

        expect(manifest.name).toBe(HOSTILE.slug);
        const scripts = Object.values(type.commands)
          .map((command) => /^npm (?:run )?(\S+)$/.exec(command)?.[1])
          .filter((script) => script !== undefined && script !== 'ci');
        for (const script of scripts) {
          expect(manifest.scripts, `npm script "${script}"`).toHaveProperty(script!);
        }
      });

      it('locks its dependencies for npm ci', async () => {
        const lock = JSON.parse((await fileOf('package-lock.json'))!) as { name: string; packages: Record<string, { name?: string }> };

        expect(lock.name).toBe(HOSTILE.slug);
        expect(lock.packages['']!.name).toBe(HOSTILE.slug);
      });
    }

    if (type.language.key === 'python') {
      it("can run each of its type's uv run commands, as a project script or a tool it depends on", async () => {
        const pyproject = (await fileOf('pyproject.toml'))!;

        expect(pyproject).toContain(`name = "${HOSTILE.slug}"`);
        expect(pyproject).toContain(`requires-python = ">=${type.language.runtime.version}"`);
        for (const command of Object.values(type.commands)) {
          const program = /^uv run (\w+)/.exec(command)?.[1];
          if (program !== undefined) {
            const isScript = new RegExp(`^${program} = "`, 'm').test(pyproject);
            const isTool = new RegExp(`^\\s+"${program}[>=<~\\[]`, 'm').test(pyproject);
            expect(isScript || isTool, `"${command}" needs a project script or a dependency named ${program}`).toBe(true);
          }
        }
      });

      it('uses the Python version of its type, and locks its dependencies for uv sync --frozen', async () => {
        expect((await fileOf('.python-version'))!.trim()).toBe(type.language.runtime.version);
        expect(await fileOf('uv.lock')).toContain(`name = "${HOSTILE.slug}"`);
      });
    }

    if (type.serving.kind === 'process') {
      it(`listens on port ${type.serving.port} unless PORT says otherwise`, async () => {
        const sources = (await render()).filter((file) => /\.(ts|py)$/.test(file.path) && !/spec|test/.test(file.path));

        expect(sources.some((file) => file.content.includes(String(type.serving.kind === 'process' && type.serving.port)))).toBe(true);
        expect(sources.some((file) => file.content.includes('PORT'))).toBe(true);
      });
    }

    if (type.commands.migrate !== undefined) {
      it('comes with a migration to show how they work', async () => {
        const paths = (await render()).map((file) => file.path);

        expect(paths.some((path) => /migrations\/(versions\/)?0001_/.test(path))).toBe(true);
      });
    }
  },
);

describe('lockfiles', () => {
  it.each(registry.scaffoldKeys())('%s has one, so installs are the ones that were verified', (key) => {
    const root = join(SCAFFOLDS_DIRECTORY, key);
    const lockfile = existsSync(join(root, 'package.json')) ? 'package-lock.json' : 'uv.lock';

    expect(existsSync(join(root, lockfile))).toBe(true);
    // Locks point at the public registries, so they work outside the machine that wrote them.
    const content = readFileSync(join(root, lockfile), 'utf8');
    expect(content).toMatch(lockfile === 'uv.lock' ? /registry = "https:\/\/pypi\.org\/simple"/ : /https:\/\/registry\.npmjs\.org\//);
  });
});
