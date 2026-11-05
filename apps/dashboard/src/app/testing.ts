import type { CurrentUser } from './core/session.service';
import type { ApplicationType } from './features/application-catalog/application-catalog.api';

export const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
export const COMPANY_B = '00000000-0000-4000-8000-00000000000b';

export const sampleUser = (overrides: Partial<CurrentUser> = {}): CurrentUser => ({
  userId: 'user-1',
  email: 'person@example.com',
  displayName: 'Sample Person',
  companyId: COMPANY_A,
  companyName: 'Acme',
  role: 'company-admin',
  permissions: ['company-users:manage', 'dashboards:view'],
  memberships: [{ companyId: COMPANY_A, companyName: 'Acme', role: 'company-admin' }],
  ...overrides,
});

/** Lets promises and Angular's rendering settle after answering a request. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve));
  }
}

const FRONTEND = { key: 'frontend', name: 'Frontend', description: 'What people use in their browser.' };
const BACKEND = { key: 'backend', name: 'Backend', description: 'Services and APIs that frontends and other software call.' };
const TYPESCRIPT = { key: 'typescript', name: 'TypeScript', runtime: { name: 'Node.js', version: '24', image: 'node:24-alpine' } };
const PYTHON = { key: 'python', name: 'Python', runtime: { name: 'Python', version: '3.13', image: 'python:3.13-slim' } };
const NPM = { install: 'npm ci', lint: 'npm run lint', test: 'npm test', build: 'npm run build' };
const UV = { install: 'uv sync --frozen', lint: 'uv run ruff check .', test: 'uv run pytest', start: 'uv run app' };

/** The catalog as the API answers it today. */
export const APPLICATION_TYPES: ApplicationType[] = [
  {
    key: 'python-frontend',
    name: 'Python frontend',
    description: 'A web app whose pages a Python process renders, such as a dashboard or data app.',
    layer: FRONTEND,
    language: PYTHON,
    frameworks: ['Streamlit', 'Reflex', 'NiceGUI'],
    serving: { kind: 'process', port: 8000, healthCheckPath: '/' },
    commands: UV,
    scaffolds: [{ key: 'streamlit', name: 'Streamlit', description: 'A Streamlit app, for dashboards and data apps.', includes: ['Tests', 'Linting'] }],
  },
  {
    key: 'typescript-frontend',
    name: 'TypeScript frontend',
    description: 'A web app that builds into static files, served as they are.',
    layer: FRONTEND,
    language: TYPESCRIPT,
    frameworks: ['Angular', 'React', 'Vue', 'Svelte'],
    serving: { kind: 'static', directory: 'dist' },
    commands: NPM,
    scaffolds: [
      { key: 'angular', name: 'Angular', description: 'An Angular app with standalone components, signals and routing.', includes: ['Tests', 'Linting'] },
      { key: 'react', name: 'React', description: 'A React app built with Vite.', includes: ['Tests', 'Linting'] },
    ],
  },
  {
    key: 'python-backend',
    name: 'Python backend',
    description: 'A Python service or API that may own a database.',
    layer: BACKEND,
    language: PYTHON,
    frameworks: ['FastAPI', 'Django', 'Flask'],
    serving: { kind: 'process', port: 8000, healthCheckPath: '/health' },
    commands: { ...UV, migrate: 'uv run migrate' },
    scaffolds: [{ key: 'fastapi', name: 'FastAPI', description: 'A FastAPI API with a health check.', includes: ['Tests', 'Linting'] }],
  },
  {
    key: 'typescript-backend',
    name: 'TypeScript backend',
    description: 'A Node.js service or API that may own a database.',
    layer: BACKEND,
    language: TYPESCRIPT,
    frameworks: ['NestJS', 'Express', 'Fastify'],
    serving: { kind: 'process', port: 3000, healthCheckPath: '/health' },
    commands: { ...NPM, start: 'npm start', migrate: 'npm run migrate' },
    scaffolds: [{ key: 'nestjs', name: 'NestJS', description: 'A NestJS API with a health check.', includes: ['Tests', 'Linting'] }],
  },
];
