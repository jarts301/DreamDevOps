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
      'application/ports.ts',
      'application/company-access.service.ts',
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
    published: ['application/invitation-emails.ts', 'notifications.module.ts'],
  },
  editions: {
    schemas: ['editions'],
    published: ['application/ports.ts', 'http/feature.guard.ts', 'editions.module.ts'],
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
    published: ['application/repository-lookup.ts', 'domain/events.ts', 'domain/git-flow.ts', 'source-governance.module.ts'],
  },
  builds: { schemas: ['builds'], published: ['application/deployable-images.ts', 'builds.module.ts'] },
  environments: {
    schemas: ['environments'],
    published: [
      'application/environment-logs.ts',
      'application/running-environments.ts',
      'domain/events.ts',
      'domain/telemetry.ts',
      'environments.module.ts',
    ],
  },
  monitoring: { schemas: [], published: ['monitoring.module.ts'] },
};

/** Schemas every context may use: the shared kernel's outbox. */
const SHARED_SCHEMAS = ['kernel'];

/**
 * Known exceptions, each with its reason. The list should only ever shrink.
 */
const EXCEPTIONS = {
  /** Application code that uses NestJS's Logger, which is harmless but ties it to the framework. */
  frameworkInApplication: ['editions/application/entitlements.ts', 'notifications/application/invitation-emails.ts'],
  /** Pure libraries the domain may use. They do no I/O and tie it to no framework. */
  librariesInDomain: ['@casl/ability'],
  /** Events created but never saved, so the audit log never shows them. */
  unrecordedEvents: ['NotificationTest'],
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

/** Every import in the source, resolved to a path from src, or kept as a package name. */
const imports = files.flatMap(({ path, text }) =>
  [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm)].map((match) => {
    const target = match[1]!;
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
    const platform = ['background', 'config', 'database', 'health', 'http', 'platform', 'sample-data', 'session', 'shared'];
    expect(folders.filter((folder) => !platform.includes(folder)).sort()).toEqual(Object.keys(CONTEXTS).sort());
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
        const framework = target.startsWith('@nestjs/') || target === 'express';
        return framework && !EXCEPTIONS.frameworkInApplication.includes(from) ? [`${from} -> ${target}`] : [];
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
