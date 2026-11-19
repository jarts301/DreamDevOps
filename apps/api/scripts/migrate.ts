// Applies the API's migrations to the local stack's database.
import { migrateApi } from '../src/database/migrate.ts';

const port = process.env.POSTGRES_PORT ?? '5433';
const password = process.env.DREAMDEVOPS_DB_OWNER_PASSWORD;
if (password === undefined) {
  throw new Error('DREAMDEVOPS_DB_OWNER_PASSWORD is not set. See infra/local/README.md.');
}

const applied = await migrateApi(`postgres://dreamdevops_owner:${encodeURIComponent(password)}@localhost:${port}/dreamdevops`);
console.log(applied.length === 0 ? 'Migrations are up to date.' : `Applied: ${applied.join(', ')}`);
