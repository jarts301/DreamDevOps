import { defineScaffold } from '../../domain/scaffold.ts';

export const FASTAPI = defineScaffold({
  key: 'fastapi',
  name: 'FastAPI',
  description: 'A FastAPI API with a health check, configuration and database migrations.',
  includes: [
    'A /health endpoint that also checks the database, once there is one',
    'Settings from environment variables, such as PORT and DATABASE_URL',
    'pytest with FastAPI’s TestClient',
    'Alembic migrations for PostgreSQL, with SQLAlchemy and psycopg',
    'Ruff for linting and formatting',
    'uv for dependencies, with a lockfile',
  ],
});
