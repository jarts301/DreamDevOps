import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the bounded contexts apart, so any of them can later become its own service.
 * ARCHITECTURE.md at the repository root explains each rule. When a rule gets in the
 * way, change the design, or add a documented exception here, never quietly.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
const DASHBOARD_EVENTS = fileURLToPath(new URL('../../dashboard/src/app/core/events.ts', import.meta.url));

interface Context {
  /** The database schemas only this context may read or write. */
  readonly schemas: readonly string[];
  /** The files other contexts may import: its published language and services. */
  readonly published: readonly string[];
}

const CONTEXTS: Readonly<Record<string, Context>> = {
  'identity-access': {
    schemas: ['identity'],
    published: [
      'domain/access.ts',
      'domain/email.ts',
      'domain/events.ts',
      'application/ports.ts',
      'application/company-access.service.ts',
      'application/company-members.ts',
      'identity-access.module.ts',
    ],
  },
  tenancy: {
    schemas: ['tenancy'],
    published: ['application/company-directory.ts', 'company-directory.module.ts', 'tenancy.module.ts'],
  },
  audit: { schemas: ['audit'], published: ['audit.module.ts'] },
  notifications: {
    schemas: ['notification'],
    published: ['application/alert-emails.ts', 'application/invitation-emails.ts', 'notifications.module.ts'],
  },
  editions: {
    schemas: ['editions'],
    published: ['application/ports.ts', 'application/entitlements.ts', 'http/feature.guard.ts', 'editions.module.ts'],
  },
  blueprints: {
    schemas: [],
    published: ['application/blueprint-catalog.ts', 'domain/blueprint.ts', 'blueprints.module.ts'],
  },
  catalog: {
    schemas: ['catalog'],
    published: ['application/application-catalog.ts', 'domain/events.ts', 'catalog.module.ts'],
  },
  'source-governance': {
    schemas: ['source'],
    published: [
      'application/ports.ts',
      'application/repository-lookup.ts',
      'domain/events.ts',
      'domain/git-flow.ts',
      'source-governance.module.ts',
    ],
  },
  webhooks: { schemas: ['webhooks'], published: ['domain/signature.ts', 'webhooks.module.ts'] },
  builds: {
    schemas: ['builds'],
    published: ['application/builds.ts', 'application/signing-keys.ts', 'builds.module.ts'],
  },
  releases: { schemas: ['releases'], published: ['releases.module.ts'] },
  environments: {
    schemas: ['environments'],
    published: [
      'application/environments.ts',
      'application/environment-config.ts',
      'application/ports.ts',
      'application/target-agents.ts',
      'application/target-configuration.ts',
      'domain/hosting-providers.ts',
      'domain/protection.ts',
      'domain/telemetry.ts',
      'domain/variables.ts',
      'environments.module.ts',
    ],
  },
  deployments: {
    schemas: ['deployments'],
    published: ['application/deployments.ts', 'deployments.module.ts'],
  },
  alerts: { schemas: ['alerts'], published: ['domain/events.ts', 'alerts.module.ts'] },
  monitoring: {
    schemas: [],
    published: ['application/latest-metrics.ts', 'application/running-places.ts', 'domain/metrics.ts', 'monitoring.module.ts'],
  },
};

/** Schemas every context may use: the shared kernel's outbox. */
const SHARED_SCHEMAS = ['kernel'];

/** Folders in src that aren't contexts: the platform every context runs on. */
const PLATFORM_FOLDERS = ['background', 'config', 'database', 'demo', 'health', 'http', 'platform', 'session', 'shared'];

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
  'shared/progress.ts',
  'shared/run-command.ts',
  'shared/sealed-box.ts',
  'shared/slug.ts',
  'tokens.ts',
];

/** The platform files that put contexts together, and so may import any context's module. */
const COMPOSITION = ['app.module.ts', 'background/background.module.ts', 'demo/'];

/** The schema each migration belongs to, by its number. Every new migration needs an entry. */
const MIGRATION_OWNERS: Readonly<Record<string, string>> = {
  '0001': 'api',
  '0002': 'api',
  '0003': 'identity',
  '0004': 'tenancy',
  '0005': 'audit',
  '0006': 'notification',
  '0007': 'audit',
  '0008': 'editions',
  '0009': 'catalog',
  '0010': 'source',
  '0011': 'webhooks',
  '0012': 'builds',
  '0013': 'releases',
  '0014': 'builds',
  '0015': 'environments',
  '0016': 'environments',
  '0017': 'deployments',
  '0018': 'catalog',
  '0019': 'catalog',
  '0020': 'releases',
  '0021': 'environments',
  '0022': 'deployments',
  '0023': 'environments',
  '0024': 'alerts',
  '0025': 'source',
  '0026': 'tenancy',
  '0027': 'audit',
  '0028': 'alerts',
};

/**
 * Known exceptions, each with its reason. The list should only ever shrink.
 */
const EXCEPTIONS = {
  /** Application code that uses NestJS's Logger, which is harmless but ties it to the framework. */
  frameworkInApplication: [
    'builds/application/builds.ts',
    'editions/application/entitlements.ts',
    'notifications/application/invitation-emails.ts',
  ],
  /** Pure libraries the domain may use. They do no I/O and tie it to no framework. */
  librariesInDomain: [] as string[],
  /** Pure libraries application code may use, besides the shared kernel and Node. */
  librariesInApplication: ['yaml'],
  /** Application code that names the database driver's types, rather than going through a port. */
  databaseInApplication: ['audit/application/audit-log.ts', 'identity-access/application/company-access.service.ts'],
  /** Events created but never saved, so the audit log never shows them. */
  unrecordedEvents: ['NotificationTest'],
  /**
   * Contexts that depend on each other, in a circle, so none of them can move on its own.
   * Each group is one cycle's members. The plan is to break them, so the list must only shrink.
   */
  contextCycles: [['identity-access', 'notifications', 'tenancy']],
  /** Platform code that reaches into a context. The guards and the request belong to Identity and access. */
  platformIntoContexts: ['http/guards.ts -> identity-access', 'http/request.ts -> identity-access'],
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
  it('knows every context in the source', () => {
    const folders = readdirSync(SRC).filter((name) => statSync(join(SRC, name)).isDirectory());
    expect(folders.filter((folder) => !PLATFORM_FOLDERS.includes(folder)).sort()).toEqual(Object.keys(CONTEXTS).sort());
  });

  it('gives each context a Nest module, which is how the application puts it together', () => {
    for (const context of Object.keys(CONTEXTS)) {
      expect(files.some((file) => file.path === `${context}/${context}.module.ts`), context).toBe(true);
    }
  });

  it('lets contexts use each other only through what they publish', () => {
    const violations = imports.flatMap(({ from, target, relative: isRelative }) => {
      const source = locate(from);
      const destination = isRelative ? locate(target) : null;
      if (source === null || destination === null || source.context === destination.context) {
        return [];
      }
      return CONTEXTS[destination.context]!.published.includes(destination.rest) ? [] : [`${from} -> ${target}`];
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

  it('keeps application code from depending on adapters, controllers or the web framework', () => {
    const violations = imports.flatMap(({ from, target, relative: isRelative }) => {
      const source = locate(from);
      if (source?.layer !== 'application') {
        return [];
      }
      if (!isRelative) {
        const allowed =
          target.startsWith('node:') ||
          target.startsWith('@dreamdevops/shared-kernel') ||
          EXCEPTIONS.librariesInApplication.includes(target) ||
          (target === '@nestjs/common' && EXCEPTIONS.frameworkInApplication.includes(from)) ||
          (target === 'pg' && EXCEPTIONS.databaseInApplication.includes(from));
        return allowed ? [] : [`${from} -> ${target}`];
      }
      const destination = locate(target);
      const adapter = destination !== null && ['infrastructure', 'http', 'messaging', 'module'].includes(destination.layer);
      return adapter ? [`${from} -> ${target}`] : [];
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

  it('has no cycles between contexts, other than the known ones', () => {
    // The contexts each context imports, then the groups of contexts that reach each other.
    const uses = new Map<string, Set<string>>(Object.keys(CONTEXTS).map((context) => [context, new Set<string>()]));
    for (const { from, target, relative: isRelative } of imports) {
      const source = locate(from);
      const destination = isRelative ? locate(target) : null;
      if (source !== null && destination !== null && source.context !== destination.context) {
        uses.get(source.context)!.add(destination.context);
      }
    }
    const reaches = (start: string, goal: string): boolean => {
      const seen = new Set<string>();
      const stack = [...uses.get(start)!];
      while (stack.length > 0) {
        const next = stack.pop()!;
        if (next === goal) {
          return true;
        }
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(...uses.get(next)!);
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

    expect([...cycles.values()]).toEqual(EXCEPTIONS.contextCycles);
  });

  it('lets contexts use only what the platform publishes', () => {
    const violations = imports.flatMap(({ from, target, relative: isRelative }) => {
      const source = locate(from);
      if (source === null || !isRelative || locate(target) !== null) {
        return [];
      }
      // Identity and access runs the sessions, which are kept in the platform's folder for now.
      const allowed = PLATFORM_API.includes(target) || (source.context === 'identity-access' && target.startsWith('session/'));
      return allowed ? [] : [`${from} -> ${target}`];
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

  it('gives every migration an owner, and keeps it to its own schema, other than the known couplings', () => {
    const schemas = [...new Set(['api', ...Object.values(CONTEXTS).flatMap((context) => context.schemas)])];
    const reference = new RegExp(`\\b(${schemas.join('|')})\\.[a-z_]+`, 'g');
    const migrations = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();

    expect(migrations.filter((name) => MIGRATION_OWNERS[name.slice(0, 4)] === undefined)).toEqual([]);
    const couplings = migrations.flatMap((name) => {
      const owner = MIGRATION_OWNERS[name.slice(0, 4)]!;
      // Only what a migration does going up: going down puts back what was there before.
      const sql = readFileSync(join(MIGRATIONS, name), 'utf8').split('-- Down Migration')[0]!.replace(/--.*$/gm, '');
      const others = [...new Set([...sql.matchAll(reference)].map((match) => match[1]!))].filter((schema) => schema !== owner).sort();
      return others.length === 0 ? [] : [`${name.slice(0, 4)} (${owner}) uses ${others.join(', ')}`];
    });
    expect(couplings).toEqual(EXCEPTIONS.crossSchemaMigrations);
  });
});

describe('events', () => {
  /** The event types the API saves, from createDomainEvent calls and the saga's status changes. */
  const published = new Set(
    files.flatMap(({ text }) => [
      ...[...text.matchAll(/eventType:\s*([^,\n]+(?:\n[^,\n]+)?)/g)].flatMap((match) =>
        [...match[1]!.matchAll(/'([A-Z][A-Za-z]+)'/g)].map((name) => name[1]!),
      ),
      ...[...text.matchAll(/setStatus\([^;]*?'([A-Z][A-Za-z]+)'/gs)].map((match) => match[1]!),
    ]),
  );

  it('are all described on the dashboard, so the audit log never shows a raw event name', () => {
    const described = new Set([...readFileSync(DASHBOARD_EVENTS, 'utf8').matchAll(/case '([A-Z][A-Za-z]+)':/g)].map((match) => match[1]!));
    const missing = [...published].filter((type) => !described.has(type) && !EXCEPTIONS.unrecordedEvents.includes(type));

    expect(published.size).toBeGreaterThan(20);
    expect(missing.sort()).toEqual([]);
  });

  it('that people can be notified about all exist', async () => {
    const { NOTIFIABLE_EVENTS } = await import('../src/notifications/domain/event-catalog.ts');

    expect(Object.keys(NOTIFIABLE_EVENTS).filter((type) => !published.has(type))).toEqual([]);
  });
});
