import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the bounded contexts apart, so any of them can later become its own service.
 * ARCHITECTURE.md at the repository root explains each rule. When a rule gets in the
 * way, change the design, or add a documented exception here, never quietly.
 */

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

interface Context {
  /** The database schemas only this context may read or write. */
  readonly schemas: readonly string[];
  /**
   * Its Nest modules, which other contexts' modules import to wire it in. Everything else a
   * context offers others is in the contracts package, @dreamdevops/contracts.
   */
  readonly modules: readonly string[];
}

const CONTEXTS: Readonly<Record<string, Context>> = {
  'identity-access': { schemas: ['identity'], modules: ['identity-access.module.ts'] },
  tenancy: { schemas: ['tenancy'], modules: ['company-directory.module.ts', 'tenancy.module.ts'] },
  audit: { schemas: ['audit'], modules: ['audit.module.ts'] },
  notifications: { schemas: ['notification'], modules: ['notifications.module.ts'] },
  editions: { schemas: ['editions'], modules: ['editions.module.ts'] },
  blueprints: { schemas: [], modules: ['blueprints.module.ts'] },
  catalog: { schemas: ['catalog'], modules: ['catalog.module.ts'] },
  'source-governance': { schemas: ['source'], modules: ['source-governance.module.ts'] },
  webhooks: { schemas: ['webhooks'], modules: ['webhooks.module.ts'] },
  builds: { schemas: ['builds'], modules: ['builds.module.ts'] },
  releases: { schemas: ['releases'], modules: ['releases.module.ts'] },
  environments: { schemas: ['environments'], modules: ['environments.module.ts'] },
  deployments: { schemas: ['deployments'], modules: ['deployments.module.ts'] },
  alerts: { schemas: ['alerts'], modules: ['alerts.module.ts'] },
  monitoring: { schemas: [], modules: ['monitoring.module.ts'] },
};

/** Schemas every context may use: the shared kernel's outbox. */
const SHARED_SCHEMAS = ['kernel'];

/** Folders in src that aren't contexts: the platform every context runs on. */
const PLATFORM_FOLDERS = ['background', 'config', 'database', 'demo', 'health', 'http', 'platform', 'shared'];

/**
 * The platform files contexts may import: how modules are put together, route access
 * rules, background work, settings, and small helpers. Anything else in the platform,
 * such as the guards, is the platform's own business.
 */
const PLATFORM_API = [
  'background/background-subscriber.ts',
  'config/app-config.ts',
  'http/access.decorators.ts',
  'http/request.ts',
  'platform/module-settings.ts',
  'shared/forgejo/forgejo-api.ts',
  'shared/names.ts',
  'shared/run-command.ts',
  'shared/sealed-box.ts',
  'shared/slug.ts',
  'tokens.ts',
];

/** The platform files that put contexts together, and so may import any context's module. */
const COMPOSITION = ['app.module.ts', 'background/background.module.ts', 'demo/'];

/**
 * Where the application starts, and the files others start from outside it, each with why.
 * Every other file in src must be reached from one of these, or it's left over.
 */
const ENTRY_POINTS: Readonly<Record<string, string>> = {
  'main.ts': 'The API',
  'database/migrate.ts': 'Tests migrate their throwaway databases with it',
};

/**
 * Each context keeps its migrations in src/<context>/migrations, and the platform keeps its own,
 * for the api schema and what every context shares, in src/database/migrations. A migration
 * belongs to the schema of the folder it's in.
 */
const PLATFORM_MIGRATIONS = 'database';
/** The last migration made before the rule that each may use only its own schema. */
const LAST_MIGRATION_BEFORE_THE_RULE = '0029';

/**
 * Known exceptions, each with its reason. The list should only ever shrink.
 */
const EXCEPTIONS = {
  /** Pure libraries the domain may use. They do no I/O and tie it to no framework. */
  librariesInDomain: [] as string[],
  /** Pure libraries application code may use, besides the shared kernel and Node. */
  librariesInApplication: ['yaml'],
  /**
   * Contexts that call each other, in a circle, through the services they publish, so none
   * of them can run without the others. There are none: Notifications keeps the company
   * names its messages need from Tenancy's events, rather than asking Tenancy.
   */
  callCycles: [] as string[][],
  /**
   * Platform code that reaches into a context, other than the composition root. There is none:
   * the guards find who a request is from through Identity and access's published Authenticator.
   */
  platformIntoContexts: [] as string[],
  /**
   * Migrations that use another context's schema, such as a foreign key to its table or a
   * function that reads it. Each has to go before its context can have its own database.
   */
  crossSchemaMigrations: [
    '0004 (tenancy) uses identity',
    '0005 (audit) uses identity, tenancy',
    '0006 (notification) uses identity, tenancy',
    '0007 (audit) uses identity',
    '0008 (editions) uses identity, tenancy',
    '0009 (catalog) uses identity, tenancy',
    '0010 (source) uses catalog, identity, tenancy',
    '0011 (webhooks) uses catalog, source, tenancy',
    '0012 (builds) uses catalog, identity, source, tenancy',
    '0013 (releases) uses catalog, identity, tenancy',
    '0015 (environments) uses identity, tenancy',
    '0016 (environments) uses tenancy',
    '0017 (deployments) uses builds, catalog, environments, identity, tenancy',
    '0018 (catalog) uses identity',
    '0022 (deployments) uses identity',
    '0024 (alerts) uses identity',
  ],
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** Every migration, with the folder it's in: a context's, or the platform's. */
const migrations = readdirSync(SRC)
  .filter((folder) => statSync(join(SRC, folder)).isDirectory())
  .flatMap((folder) => {
    const directory = join(SRC, folder, 'migrations');
    try {
      return readdirSync(directory)
        .filter((name) => name.endsWith('.sql'))
        .map((name) => ({ folder, name, path: join(directory, name) }));
    } catch {
      return [];
    }
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}));

/** Where a file sits: its context and layer, or null for the platform code around them. */
function locate(path: string): { context: string; layer: string; rest: string } | null {
  const [context, ...rest] = path.split('/');
  if (context === undefined || CONTEXTS[context] === undefined) {
    return null;
  }
  return { context, layer: rest.length > 1 ? rest[0]! : 'module', rest: rest.join('/') };
}

/**
 * Every import in the source, resolved to a path from src, or kept as a package name:
 * imports and re-exports, imports only for their effect, and dynamic imports.
 */
const IMPORT_PATTERN = /^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;
const imports = files.flatMap(({ path, text }) =>
  [...text.matchAll(IMPORT_PATTERN)].map((match) => {
    const target = (match[1] ?? match[2] ?? match[3])!;
    return {
      from: path,
      target: target.startsWith('.') ? relative(SRC, resolve(SRC, dirname(path), target)).split(sep).join('/') : target,
      relative: target.startsWith('.'),
    };
  }),
);

describe('the architecture', () => {
  it('has no files the application never uses, such as one left over after a move', () => {
    const reached = new Set<string>();
    const stack = Object.keys(ENTRY_POINTS);
    while (stack.length > 0) {
      const path = stack.pop()!;
      if (!reached.has(path)) {
        reached.add(path);
        stack.push(...imports.filter(({ from, relative: isRelative }) => from === path && isRelative).map(({ target }) => target));
      }
    }
    const unused = files.map(({ path }) => path).filter((path) => !reached.has(path));

    expect(unused, 'Delete these, or import them from where they belong').toEqual([]);
  });

  it('knows every context in the source', () => {
    const folders = readdirSync(SRC).filter((name) => statSync(join(SRC, name)).isDirectory());
    expect(folders.filter((folder) => !PLATFORM_FOLDERS.includes(folder)).sort()).toEqual(Object.keys(CONTEXTS).sort());
  });

  it('gives each context a Nest module, which is how the application puts it together', () => {
    for (const context of Object.keys(CONTEXTS)) {
      expect(files.some((file) => file.path === `${context}/${context}.module.ts`), context).toBe(true);
    }
  });

  it('lets contexts reach each other only through the contracts, and only their Nest modules wire them together', () => {
    const violations = imports.flatMap(({ from, target, relative: isRelative }) => {
      const source = locate(from);
      const destination = isRelative ? locate(target) : null;
      if (source === null || destination === null || source.context === destination.context) {
        return [];
      }
      const wiring = source.layer === 'module' && CONTEXTS[destination.context]!.modules.includes(destination.rest);
      return wiring ? [] : [`${from} -> ${target}`];
    });
    expect(violations).toEqual([]);
  });

  it('keeps the domain free of frameworks, databases and the layers around it', () => {
    const violations = imports.flatMap(({ from, target, relative: isRelative }) => {
      const source = locate(from);
      if (source?.layer !== 'domain') {
        return [];
      }
      if (!isRelative) {
        const allowed =
          target.startsWith('node:') ||
          target === '@dreamdevops/shared-kernel' ||
          target.startsWith('@dreamdevops/contracts/') ||
          EXCEPTIONS.librariesInDomain.includes(target);
        return allowed ? [] : [`${from} -> ${target}`];
      }
      const destination = locate(target);
      const allowed =
        target.startsWith('shared/') || (destination !== null && (destination.layer === 'domain' || destination.layer === 'module'));
      return allowed && destination?.layer !== 'module' ? [] : [`${from} -> ${target}`];
    });
    expect(violations).toEqual([]);
  });

  it('lets each context read and write only its own tables', () => {
    const violations = files.flatMap(({ path, text }) => {
      const location = locate(path);
      if (location === null) {
        return [];
      }
      const allowed = [...CONTEXTS[location.context]!.schemas, ...SHARED_SCHEMAS];
      return [...text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)\.[a-z_]+/g)]
        .map((match) => match[1]!)
        .filter((schema) => !allowed.includes(schema))
        .map((schema) => `${path} uses the ${schema} schema`);
    });
    expect([...new Set(violations)]).toEqual([]);
  });

  it('lets only the platform wire up other contexts’ background work', () => {
    const violations = imports.flatMap(({ from, target, relative: isRelative }) => {
      const destination = isRelative ? locate(target) : null;
      const source = locate(from);
      return destination?.layer === 'messaging' && source !== null && source.context !== destination.context
        ? [`${from} -> ${target}`]
        : [];
    });
    expect(violations).toEqual([]);
  });

  it('has no cycles of calls between contexts, other than the known ones', () => {
    // A context calls another when it uses a service the other publishes in its contracts.
    // Events don't count: a context that only hears another's events runs without it.
    const SERVICES = /^@dreamdevops\/contracts\/([a-z-]+)\/services$/;
    const calls = new Map<string, Set<string>>(Object.keys(CONTEXTS).map((context) => [context, new Set<string>()]));
    for (const { from, target } of imports) {
      const source = locate(from);
      const callee = SERVICES.exec(target)?.[1];
      if (source !== null && callee !== undefined && callee !== source.context) {
        calls.get(source.context)!.add(callee);
      }
    }
    const reaches = (start: string, goal: string): boolean => {
      const seen = new Set<string>();
      const stack = [...calls.get(start)!];
      while (stack.length > 0) {
        const next = stack.pop()!;
        if (next === goal) {
          return true;
        }
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(...(calls.get(next) ?? []));
        }
      }
      return false;
    };
    const cycles = new Map<string, string[]>();
    for (const context of Object.keys(CONTEXTS).sort()) {
      const group = Object.keys(CONTEXTS)
        .filter((other) => other === context || (reaches(context, other) && reaches(other, context)))
        .sort();
      if (group.length > 1) {
        cycles.set(group.join(), group);
      }
    }

    expect([...calls.values()].some((callees) => callees.size > 0)).toBe(true);
    expect([...cycles.values()]).toEqual(EXCEPTIONS.callCycles);
  });

  it('lets contexts use only what the platform publishes', () => {
    const violations = imports.flatMap(({ from, target, relative: isRelative }) => {
      const source = locate(from);
      if (source === null || !isRelative || locate(target) !== null) {
        return [];
      }
      return PLATFORM_API.includes(target) ? [] : [`${from} -> ${target}`];
    });
    expect(violations).toEqual([]);
  });

  it('lets only the composition root reach into contexts from the platform', () => {
    const reaching = new Set(
      imports.flatMap(({ from, target, relative: isRelative }) => {
        const destination = isRelative ? locate(target) : null;
        if (locate(from) !== null || destination === null || COMPOSITION.some((root) => from.startsWith(root))) {
          return [];
        }
        return [`${from} -> ${destination.context}`];
      }),
    );
    expect([...reaching].sort()).toEqual(EXCEPTIONS.platformIntoContexts);
  });

  it('keeps each migration beside its context, numbered once across them all', () => {
    const misplaced = migrations.filter(({ folder }) => folder !== PLATFORM_MIGRATIONS && CONTEXTS[folder]?.schemas.length !== 1);
    const numbers = migrations.map(({ name }) => name.slice(0, 4));

    expect(
      misplaced.map(({ folder, name }) => `${folder}/migrations/${name}`),
      'Only the platform, and contexts with a schema of their own, have migrations',
    ).toEqual([]);
    expect(numbers.every((number) => /^\d{4}$/.test(number))).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('keeps every migration to its own schema, other than the known couplings made before the rule', () => {
    const schemas = [...new Set(['api', ...Object.values(CONTEXTS).flatMap((context) => context.schemas)])];
    const reference = new RegExp(`\\b(${schemas.join('|')})\\.[a-z_]+`, 'g');

    const couplings = migrations.flatMap(({ folder, name, path }) => {
      const owner = folder === PLATFORM_MIGRATIONS ? 'api' : CONTEXTS[folder]!.schemas[0]!;
      // Only what a migration does going up: going down puts back what was there before.
      const sql = readFileSync(path, 'utf8').split('-- Down Migration')[0]!.replace(/--.*$/gm, '');
      const others = [...new Set([...sql.matchAll(reference)].map((match) => match[1]!))].filter((schema) => schema !== owner).sort();
      return others.length === 0 ? [] : [`${name.slice(0, 4)} (${owner}) uses ${others.join(', ')}`];
    });
    expect(couplings).toEqual(EXCEPTIONS.crossSchemaMigrations);
    // The list is closed: a later migration that needs another schema needs a different design.
    expect(EXCEPTIONS.crossSchemaMigrations.filter((coupling) => coupling.slice(0, 4) > LAST_MIGRATION_BEFORE_THE_RULE)).toEqual([]);
  });

  it("lets each context's database work run only as its own role", () => {
    const violations = files.flatMap(({ path, text }) => {
      // Database roles, not company ones such as developer.
      const roles = [...text.matchAll(/\brole: '(dreamdevops_[a-z_]+)'/g)].map((match) => match[1]!);
      const location = locate(path);
      if (location === null) {
        return roles.map((role) => `${path} works as ${role}, but only a context's own code switches roles`);
      }
      const own = CONTEXTS[location.context]!.schemas.map((schema) => `dreamdevops_${schema}`);
      return roles.filter((role) => !own.includes(role)).map((role) => `${path} works as ${role}`);
    });
    expect(violations).toEqual([]);
  });
});

/**
 * Inside each context, each layer has one job. The domain holds the rules; application
 * code runs the use cases, through ports; infrastructure adapts ports to outside tools,
 * such as PostgreSQL; controllers carry HTTP and subscribers carry events and jobs, each
 * to the context's own use cases; the Nest module puts them together.
 */
describe('the layers inside each context', () => {
  const inLayer = (path: string, ...layers: string[]) => layers.includes(locate(path)?.layer ?? '');
  /** What talks to the database: the shared kernel's PostgreSQL building blocks and the driver. */
  const isDatabase = (target: string) => target === '@dreamdevops/shared-kernel/postgres' || target === 'pg';
  /** SQL, as code that talks to PostgreSQL writes it. */
  const SQL = /['"`]\s*(?:SELECT\s[\s\S]*?\sFROM\s|INSERT\s+INTO\s|UPDATE\s+[a-z_]+\.[a-z_]+\s+SET\s|DELETE\s+FROM\s)/i;

  it('keeps the database in adapters and modules, so only they know how data is kept', () => {
    const violations = imports
      .filter(({ from, target }) => isDatabase(target) && locate(from) !== null && !inLayer(from, 'infrastructure', 'module'))
      .map(({ from, target }) => `${from} -> ${target}`);

    expect(violations).toEqual([]);
  });

  it('keeps SQL out of the domain, the use cases, the controllers and the subscribers', () => {
    const violations = files
      .filter(({ path }) => inLayer(path, 'domain', 'application', 'http', 'messaging'))
      .filter(({ text }) => SQL.test(text))
      .map(({ path }) => path);

    expect(violations).toEqual([]);
  });

  it('keeps use cases free of adapters, controllers, subscribers and the web framework', () => {
    const violations = imports.flatMap(({ from, target, relative: isRelative }) => {
      if (!inLayer(from, 'application')) {
        return [];
      }
      if (!isRelative) {
        const allowed =
          target.startsWith('node:') ||
          target === '@dreamdevops/shared-kernel' ||
          target.startsWith('@dreamdevops/contracts/') ||
          EXCEPTIONS.librariesInApplication.includes(target);
        return allowed ? [] : [`${from} -> ${target}`];
      }
      return inLayer(target, 'infrastructure', 'http', 'messaging', 'module') ? [`${from} -> ${target}`] : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps controllers and subscribers to carrying requests and events to their own use cases', () => {
    const violations = imports.flatMap(({ from, target, relative: isRelative }) => {
      const source = locate(from);
      if (source === null || !inLayer(from, 'http', 'messaging')) {
        return [];
      }
      if (!isRelative) {
        // Another context's services are its use cases' business, never a controller's.
        const service = /^@dreamdevops\/contracts\/[a-z-]+\/services$/.test(target);
        return service || isDatabase(target) ? [`${from} -> ${target}`] : [];
      }
      const destination = locate(target);
      if (destination === null) {
        return [];
      }
      const own = destination.context === source.context && ['application', 'domain'].includes(destination.layer);
      const sameLayer = destination.context === source.context && destination.layer === source.layer;
      return own || sameLayer ? [] : [`${from} -> ${target}`];
    });

    expect(violations).toEqual([]);
  });

  it('keeps adapters from reaching back into controllers, subscribers or the module', () => {
    const violations = imports
      .filter(({ from, target, relative: isRelative }) => isRelative && inLayer(from, 'infrastructure') && inLayer(target, 'http', 'messaging', 'module'))
      .map(({ from, target }) => `${from} -> ${target}`);

    expect(violations).toEqual([]);
  });

  it('gives each context that keeps data a store, which its use cases reach through a port', () => {
    const withData = Object.entries(CONTEXTS)
      .filter(([, context]) => context.schemas.length > 0)
      .map(([name]) => name);
    const missing = withData.filter((context) => {
      const port = files.find(({ path }) => path === `${context}/application/ports.ts`);
      const adapter = files.some(({ path, text }) => path.startsWith(`${context}/infrastructure/`) && text.includes('@dreamdevops/shared-kernel/postgres'));
      return port === undefined || !/export const [A-Z_]+_STORE = Symbol/.test(port.text) || !adapter;
    });

    expect(withData.length).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });
});

describe('events', () => {
  it('are only ever made through their contracts, so none is published without one', () => {
    const bypassing = files.filter(({ text }) => /\bcreateDomainEvent\b/.test(text)).map(({ path }) => path);

    expect(bypassing).toEqual([]);
  });

  it('that people can be notified about all have contracts, which word them', async () => {
    const { NOTIFIABLE_EVENTS } = await import('../../src/notifications/domain/event-catalog.ts');
    const { EVENT_CATALOG } = await import('@dreamdevops/contracts/events');

    expect(Object.keys(NOTIFIABLE_EVENTS).filter((type) => !EVENT_CATALOG.has(type))).toEqual([]);
  });
});

describe('the HTTP API', () => {
  it('answers with the types its contexts publish in their contracts, never a bare object', () => {
    const untyped = files
      .filter(({ path }) => /\/http\/[^/]+\.controller\.ts$/.test(path))
      .flatMap(({ path, text }) => [...text.matchAll(/\)\s*:\s*(?:Promise<)?object\b/g)].map(() => path));

    expect(untyped).toEqual([]);
  });
});
