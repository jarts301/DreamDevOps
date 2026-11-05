// Seeds the local stack: the demo company and its sample users. Safe to run any number of
// times. npm run start:api runs it, unless SEED_DEMO_COMPANY=false, and npm run db:seed runs it alone.
import pg from 'pg';
import { DEMO_COMPANY, DEMO_MEMBERS, PLATFORM_ADMIN, seedDemoCompany } from './demo-company.ts';
import { keycloakUsers } from './keycloak-users.ts';

const setting = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Copy any new settings from infra/local/.env.example to .env.`);
  }
  return value;
};

export async function seedLocal(): Promise<void> {
  const users = await keycloakUsers({
    url: `http://localhost:${process.env['KEYCLOAK_PORT'] ?? '8081'}`,
    realm: 'dreamdevops',
    username: setting('KEYCLOAK_ADMIN_USERNAME'),
    password: setting('KEYCLOAK_ADMIN_PASSWORD'),
  });
  const subjects = new Map<string, string>();
  // The Platform Admin comes from the realm file, with its role, so it's only looked up.
  const platformAdmin = await users.find(PLATFORM_ADMIN.username);
  if (platformAdmin === undefined) {
    throw new Error(`Keycloak has no ${PLATFORM_ADMIN.username}. Reset the local stack to import the realm again.`);
  }
  subjects.set(PLATFORM_ADMIN.username, platformAdmin);
  for (const member of DEMO_MEMBERS) {
    subjects.set(member.username, await users.ensure(member, setting('KEYCLOAK_DEV_USER_PASSWORD')));
  }

  const password = encodeURIComponent(setting('DREAMDEVOPS_DB_APP_PASSWORD'));
  const pool = new pg.Pool({
    connectionString: `postgres://dreamdevops_app:${password}@localhost:${process.env['POSTGRES_PORT'] ?? '5433'}/dreamdevops`,
  });
  try {
    const { created } = await seedDemoCompany(pool, subjects);
    console.log(
      created
        ? `Created ${DEMO_COMPANY.name}, with a sample user in each role. The API sets up its Git organization once it starts.`
        : `${DEMO_COMPANY.name} is already there.`,
    );
  } finally {
    await pool.end();
  }
}

// Run directly, as npm run db:seed does.
if (import.meta.url === `file://${process.argv[1]}`) {
  await seedLocal();
}
