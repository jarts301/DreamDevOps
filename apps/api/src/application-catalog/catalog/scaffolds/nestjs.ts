import { defineScaffold } from '../../domain/scaffold.ts';

export const NESTJS = defineScaffold({
  key: 'nestjs',
  name: 'NestJS',
  description: 'A NestJS API with a health check, configuration and database migrations.',
  includes: [
    'A /health endpoint that also checks the database, once there is one',
    'Settings from environment variables, such as PORT and DATABASE_URL',
    'Jest for unit tests, and Supertest for end-to-end tests',
    'SQL migrations for PostgreSQL with node-pg-migrate',
    'ESLint with typescript-eslint, and Prettier',
  ],
});
