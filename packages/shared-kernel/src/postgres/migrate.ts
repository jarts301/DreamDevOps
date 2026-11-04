import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations', import.meta.url));

/** Applies the kernel's migrations. Connect as the dreamdevops_owner role. */
export async function migrateSharedKernel(connectionString: string): Promise<string[]> {
  const applied = await runner({
    databaseUrl: connectionString,
    dir: MIGRATIONS_DIRECTORY,
    direction: 'up',
    migrationsTable: 'shared_kernel_migrations',
    schema: 'kernel',
    createSchema: true,
    log: () => {},
  });
  return applied.map((migration) => migration.name);
}
