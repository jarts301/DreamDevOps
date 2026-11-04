import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations', import.meta.url));

/** Applies the API's migrations. Connect as the dreamdevops_owner role. */
export async function migrateApi(connectionString: string): Promise<string[]> {
  const applied = await runner({
    databaseUrl: connectionString,
    dir: MIGRATIONS_DIRECTORY,
    direction: 'up',
    migrationsTable: 'api_migrations',
    schema: 'api',
    createSchema: true,
    log: () => {},
  });
  return applied.map((migration) => migration.name);
}
