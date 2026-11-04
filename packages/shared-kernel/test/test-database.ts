import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrateSharedKernel } from '../src/postgres/migrate.ts';

const BOOTSTRAP_SQL = fileURLToPath(new URL('../../../infra/local/postgres/init-platform-database.sql', import.meta.url));

export interface TestDatabase {
  readonly container: StartedPostgreSqlContainer;
  urlFor(role: 'owner' | 'app' | 'relay' | 'jobs'): string;
  stop(): Promise<void>;
}

/** Starts a disposable PostgreSQL, set up by the same script and migrations as the local stack. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:17.11-alpine')
    .withCopyFilesToContainer([{ source: BOOTSTRAP_SQL, target: '/tmp/init-platform-database.sql' }])
    .start();

  const bootstrap = await container.exec([
    'psql',
    '-U',
    container.getUsername(),
    '-d',
    'postgres',
    '-v',
    'owner_password=owner',
    '-v',
    'app_password=app',
    '-v',
    'relay_password=relay',
    '-v',
    'jobs_password=jobs',
    '-f',
    '/tmp/init-platform-database.sql',
  ]);
  if (bootstrap.exitCode !== 0) {
    throw new Error(`Database setup failed: ${bootstrap.output}`);
  }

  const urlFor: TestDatabase['urlFor'] = (role) =>
    `postgres://dreamdevops_${role}:${role}@${container.getHost()}:${container.getPort()}/dreamdevops`;

  await migrateSharedKernel(urlFor('owner'));

  return {
    container,
    urlFor,
    stop: async () => {
      await container.stop();
    },
  };
}
