import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplicationTypeRegistry } from '../src/application-catalog/application/application-type-registry.ts';
import { BACKEND, FRONTEND } from '../src/application-catalog/catalog/layers.ts';
import { APPLICATION_TYPE_CATALOG } from '../src/application-catalog/catalog/index.ts';
import { PYTHON } from '../src/application-catalog/catalog/languages/python.ts';
import { TYPESCRIPT } from '../src/application-catalog/catalog/languages/typescript.ts';
import {
  type ApplicationType,
  defineApplicationType,
  type Language,
} from '../src/application-catalog/domain/application-type.ts';
import { InvalidApplicationTypeError, validateApplicationType } from '../src/application-catalog/domain/validation.ts';
import { createTestApp } from './test-app.ts';

const registry = new ApplicationTypeRegistry(APPLICATION_TYPE_CATALOG);

describe('the catalog', () => {
  it('offers a frontend and a backend in TypeScript and in Python, frontends first', () => {
    expect(registry.list().map((type) => type.key)).toEqual([
      'python-frontend',
      'typescript-frontend',
      'python-backend',
      'typescript-backend',
    ]);
  });

  // Every type added later runs through these too, with no new test to write.
  describe.each(APPLICATION_TYPE_CATALOG.map((type) => [type.key, type] as const))('%s', (_key, type) => {
    it('follows every rule of the catalog', () => {
      expect(() => validateApplicationType(type)).not.toThrow();
    });

    it('can be installed, linted and tested', () => {
      expect(type.commands).toEqual(
        expect.objectContaining({ install: expect.any(String), lint: expect.any(String), test: expect.any(String) }),
      );
    });

    it('runs migrations only if it may own a database', () => {
      expect(type.commands.migrate !== undefined).toBe(type.layer.migrations);
    });

    it('names frameworks that follow its conventions', () => {
      expect(type.frameworks.length).toBeGreaterThan(0);
    });
  });

  it('describes each type the way the dashboard shows it', () => {
    expect(registry.get('typescript-frontend')).toMatchObject({
      name: 'TypeScript frontend',
      language: { name: 'TypeScript', runtime: { name: 'Node.js', version: '24', image: 'node:24-alpine' } },
      serving: { kind: 'static', directory: 'dist' },
      commands: { install: 'npm ci', lint: 'npm run lint', test: 'npm test', build: 'npm run build' },
    });
    expect(registry.get('typescript-frontend')!.commands).not.toHaveProperty('start');
    expect(registry.get('python-backend')).toMatchObject({
      name: 'Python backend',
      serving: { kind: 'process', port: 8000, healthCheckPath: '/health' },
      commands: { install: 'uv sync --frozen', start: 'uv run app', migrate: 'uv run migrate' },
    });
    expect(registry.get('python-frontend')).toMatchObject({
      serving: { kind: 'process', port: 8000, healthCheckPath: '/' },
      commands: { start: 'uv run app' },
    });
    expect(registry.get('python-frontend')!.commands).not.toHaveProperty('migrate');
    expect(registry.get('typescript-backend')).toMatchObject({
      serving: { kind: 'process', port: 3000, healthCheckPath: '/health' },
      commands: { build: 'npm run build', start: 'npm start', migrate: 'npm run migrate' },
    });
  });

  it('offers scaffolds for every type: Angular and React, Streamlit, NestJS and FastAPI', () => {
    expect(registry.scaffoldsOf('typescript-frontend')).toEqual([
      { key: 'angular', name: 'Angular' },
      { key: 'react', name: 'React' },
    ]);
    expect(registry.scaffoldsOf('python-frontend')).toEqual([{ key: 'streamlit', name: 'Streamlit' }]);
    expect(registry.scaffoldsOf('typescript-backend')).toEqual([{ key: 'nestjs', name: 'NestJS' }]);
    expect(registry.scaffoldsOf('python-backend')).toEqual([{ key: 'fastapi', name: 'FastAPI' }]);
    expect(registry.scaffoldsOf('cobol-mainframe')).toEqual([]);
    expect(registry.scaffold('react')?.type.key).toBe('typescript-frontend');
  });

  it('knows which keys are types', () => {
    expect(registry.has('python-backend')).toBe(true);
    expect(registry.has('cobol-mainframe')).toBe(false);
    expect(registry.has('')).toBe(false);
    expect(registry.get('cobol-mainframe')).toBeUndefined();
  });
});

describe('adding a type', () => {
  const GO: Language = {
    key: 'go',
    name: 'Go',
    runtime: { name: 'Go', version: '1.25', image: 'golang:1.25-alpine' },
    commands: {
      install: 'go mod download',
      lint: 'go vet ./...',
      test: 'go test ./...',
      build: 'go build -o app .',
      start: './app',
      migrate: './app migrate',
    },
    defaultPort: 8080,
  };

  it('needs only a language and a few lines', () => {
    const goBackend = defineApplicationType({
      language: GO,
      layer: BACKEND,
      description: 'A Go service or API that may own a database.',
      frameworks: ['Gin', 'Echo'],
      serving: { kind: 'process', healthCheckPath: '/health' },
    });

    const extended = new ApplicationTypeRegistry([...APPLICATION_TYPE_CATALOG, goBackend]);

    expect(extended.get('go-backend')).toMatchObject({
      name: 'Go backend',
      serving: { kind: 'process', port: 8080, healthCheckPath: '/health' },
      commands: { install: 'go mod download', build: 'go build -o app .', start: './app', migrate: './app migrate' },
    });
    // Backends come after frontends, and by language name among themselves.
    expect(extended.list().map((type) => type.key).slice(2)).toEqual(['go-backend', 'python-backend', 'typescript-backend']);
  });

  it('lets a language have more than one type in a layer', () => {
    const nextFrontend = defineApplicationType({
      key: 'typescript-frontend-ssr',
      name: 'TypeScript frontend with server rendering',
      language: TYPESCRIPT,
      layer: FRONTEND,
      description: 'A web app whose pages a Node.js process renders.',
      frameworks: ['Next.js', 'Nuxt'],
      serving: { kind: 'process', healthCheckPath: '/' },
    });

    const extended = new ApplicationTypeRegistry([...APPLICATION_TYPE_CATALOG, nextFrontend]);

    expect(extended.get('typescript-frontend-ssr')?.commands).toMatchObject({ build: 'npm run build', start: 'npm start' });
    expect(extended.get('typescript-frontend-ssr')?.commands).not.toHaveProperty('migrate');
  });

  it('lets a type replace one of its language commands', () => {
    const type = defineApplicationType({
      language: PYTHON,
      layer: BACKEND,
      description: 'A Django service.',
      frameworks: ['Django'],
      serving: { kind: 'process', port: 8001, healthCheckPath: '/healthz' },
      commands: { migrate: 'uv run python manage.py migrate' },
      key: 'python-backend-django',
    });

    expect(type.commands).toMatchObject({ migrate: 'uv run python manage.py migrate', start: 'uv run app' });
    expect(type.serving).toEqual({ kind: 'process', port: 8001, healthCheckPath: '/healthz' });
  });
});

describe('the rules', () => {
  const valid = APPLICATION_TYPE_CATALOG[0]!;
  const withChanges = (changes: Partial<ApplicationType>): ApplicationType => ({ ...valid, ...changes });
  const backend = registry.get('python-backend')!;

  it.each<[string, ApplicationType, string]>([
    ['a key with capitals', withChanges({ key: 'TypeScript' }), 'needs a key'],
    ['a key that is too long', withChanges({ key: 'x'.repeat(61) }), 'needs a key'],
    ['no name', withChanges({ name: ' ' }), 'needs a name'],
    ['no description', withChanges({ description: '' }), 'needs a description'],
    ['a framework with no name', withChanges({ frameworks: ['React', ''] }), 'framework with no name'],
    ['an empty command', withChanges({ commands: { ...valid.commands, test: ' ' } }), 'empty test command'],
    [
      'built files outside the repository',
      withChanges({ serving: { kind: 'static', directory: '../elsewhere' } }),
      'build directory inside the repository',
    ],
    [
      'built files with nothing to build them',
      withChanges({ commands: { install: 'npm ci', lint: 'npm run lint', test: 'npm test' } }),
      'needs a build command',
    ],
    [
      'built files with something to start',
      withChanges({ commands: { ...valid.commands, start: 'npm start' } }),
      'nothing to start',
    ],
    [
      'a process with no start command',
      { ...backend, commands: { install: 'uv sync', lint: 'ruff', test: 'pytest' } },
      'needs a start command',
    ],
    ['a port out of range', { ...backend, serving: { kind: 'process', port: 70_000, healthCheckPath: '/' } }, 'port'],
    [
      'a health check path without a slash',
      { ...backend, serving: { kind: 'process', port: 8000, healthCheckPath: 'health' } },
      'health check path',
    ],
    [
      'migrations in a layer without a database',
      withChanges({ commands: { ...valid.commands, migrate: 'npm run migrate' } }),
      "can't have migrations",
    ],
  ])('refuses %s', (_problem, type, message) => {
    expect(() => validateApplicationType(type)).toThrow(InvalidApplicationTypeError);
    expect(() => validateApplicationType(type)).toThrow(message);
  });

  it.each<[string, ApplicationType['scaffolds'][number], string]>([
    ['a scaffold key with capitals', { key: 'React', name: 'React', description: 'x', includes: ['x'] }, 'whose key'],
    ['a scaffold with no name', { key: 'react-2', name: ' ', description: 'x', includes: ['x'] }, 'no name'],
    ['a scaffold that includes nothing', { key: 'react-2', name: 'R', description: 'x', includes: [] }, 'includes'],
  ])('refuses %s', (_problem, scaffold, message) => {
    expect(() => validateApplicationType(withChanges({ scaffolds: [scaffold] }))).toThrow(message);
  });

  it('refuses a scaffold two types share, because applications store its key alone', () => {
    const twin = { ...backend, key: 'python-backend-twin', scaffolds: backend.scaffolds };

    expect(() => new ApplicationTypeRegistry([...APPLICATION_TYPE_CATALOG, twin])).toThrow(
      'has the scaffold "fastapi", which another type has too.',
    );
  });

  it('refuses a type defined twice', () => {
    expect(() => new ApplicationTypeRegistry([...APPLICATION_TYPE_CATALOG, valid])).toThrow(
      `Application type "${valid.key}" is defined twice.`,
    );
  });
});

describe('GET /application-types', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({ config: { secureCookies: false } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('asks anonymous users to sign in', async () => {
    await request(app.getHttpServer()).get('/api/v1/application-types').expect(401);
  });

  it('shows the catalog to anyone signed in, even without a company', async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.get('/api/v1/auth/login?login_hint=platform-admin').expect(302);
    const callback = new URL(login.headers.location as string);
    await agent.get(callback.pathname + callback.search).expect(302);

    const { body } = await agent.get('/api/v1/application-types').expect(200);

    expect(body).toHaveLength(4);
    expect(body[0]).toEqual({
      key: 'python-frontend',
      name: 'Python frontend',
      description: 'A web app whose pages a Python process renders, such as a dashboard or data app.',
      layer: { key: 'frontend', name: 'Frontend', description: 'What people use in their browser.' },
      language: { key: 'python', name: 'Python', runtime: { name: 'Python', version: '3.13', image: 'python:3.13-slim' } },
      frameworks: ['Streamlit', 'Reflex', 'NiceGUI'],
      serving: { kind: 'process', port: 8000, healthCheckPath: '/' },
      commands: { install: 'uv sync --frozen', lint: 'uv run ruff check .', test: 'uv run pytest', start: 'uv run app' },
      scaffolds: [
        expect.objectContaining({ key: 'streamlit', name: 'Streamlit', includes: expect.arrayContaining([expect.any(String)]) }),
      ],
    });
    expect(body.map((type: { scaffolds: { key: string }[] }) => type.scaffolds.map((scaffold) => scaffold.key))).toEqual([
      ['streamlit'],
      ['angular', 'react'],
      ['fastapi'],
      ['nestjs'],
    ]);
  });
});
