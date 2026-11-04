// Applies the API's migrations to the local stack's database.
import { runner } from 'node-pg-migrate';
import { fileURLToPath } from 'node:url';

const port = process.env.POSTGRES_PORT ?? '5433';
const password = process.env.DREAMDEVOPS_DB_OWNER_PASSWORD;
if (password === undefined) {
  throw new Error('DREAMDEVOPS_DB_OWNER_PASSWORD is not set. See infra/local/README.md.');
}

const applied = await runner({
  databaseUrl: `postgres://dreamdevops_owner:${encodeURIComponent(password)}@localhost:${port}/dreamdevops`,
  dir: fileURLToPath(new URL('../migrations', import.meta.url)),
  direction: 'up',
  migrationsTable: 'api_migrations',
  schema: 'api',
  createSchema: true,
  log: () => {},
});
console.log(applied.length === 0 ? 'Migrations are up to date.' : `Applied: ${applied.map((m) => m.name).join(', ')}`);
