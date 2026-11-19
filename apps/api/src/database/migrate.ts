import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

/** The API's source folder, from here or from the built code beside it. */
const SOURCE = fileURLToPath(new URL('../../src/', import.meta.url)).replaceAll('\\', '/');

/**
 * Where the API's migrations are: each context's own, in src/<context>/migrations, and the
 * platform's, in src/database/migrations. They run in the order of their numbers across all
 * the folders, as they did when they shared one, so a database migrated before keeps its
 * record of what was applied.
 */
export const MIGRATION_FILES = `${SOURCE}*/migrations/*.sql`;

/** Applies the API's migrations. Connect as the dreamdevops_owner role. */
export async function migrateApi(connectionString: string): Promise<string[]> {
  const applied = await runner({
    databaseUrl: connectionString,
    dir: MIGRATION_FILES,
    useGlob: true,
    direction: 'up',
    migrationsTable: 'api_migrations',
    schema: 'api',
    createSchema: true,
    log: () => {},
  });
  return applied.map((migration) => migration.name);
}
