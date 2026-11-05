import { fileURLToPath } from 'node:url';
import { migrateSharedKernel } from '@dreamdevops/shared-kernel/postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { AppConfig } from '../src/config/app-config.ts';
import { migrateApi } from '../src/database/migrate.ts';

const BOOTSTRAP_SQL = fileURLToPath(new URL('../../../infra/local/postgres/init-platform-database.sql', import.meta.url));

export interface TestDatabase {
  urlFor(role: 'owner' | 'app' | 'relay' | 'jobs'): string;
  /** The settings that connect an application to this database, one role per purpose. */
  config(): Pick<AppConfig, 'databaseUrl' | 'relayDatabaseUrl' | 'jobsDatabaseUrl'>;
  stop(): Promise<void>;
}

export interface TestDatabaseOptions {
  /** Set to false to apply the API's migrations yourself, such as to test an upgrade. */
  readonly migrateApi?: boolean;
}

/** Starts a disposable PostgreSQL, set up by the same script and migrations as the local stack. */
export async function startTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:17.11-alpine')
    .withCopyFilesToContainer([{ source: BOOTSTRAP_SQL, target: '/tmp/init-platform-database.sql' }])
    .start();
  const bootstrap = await container.exec([
    'psql',
    '-U',
    container.getUsername(),
    '-d',
    'postgres',
    ...['owner', 'app', 'relay', 'jobs'].flatMap((role) => ['-v', `${role}_password=fake-dummy-${role}-password`]),
    '-f',
    '/tmp/init-platform-database.sql',
  ]);
  if (bootstrap.exitCode !== 0) {
    throw new Error(`Database setup failed: ${bootstrap.output}`);
  }

  const urlFor: TestDatabase['urlFor'] = (role) =>
    `postgres://dreamdevops_${role}:fake-dummy-${role}-password@${container.getHost()}:${container.getPort()}/dreamdevops`;
  await migrateSharedKernel(urlFor('owner'));
  if (options.migrateApi !== false) {
    await migrateApi(urlFor('owner'));
  }

  return {
    urlFor,
    config: () => ({ databaseUrl: urlFor('app'), relayDatabaseUrl: urlFor('relay'), jobsDatabaseUrl: urlFor('jobs') }),
    stop: async () => {
      await container.stop();
    },
  };
}
