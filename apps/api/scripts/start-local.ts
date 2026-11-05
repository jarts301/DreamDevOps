// Starts the built API against the local stack, using the settings in infra/local/.env.
const setting = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is not set. Copy any new settings from infra/local/.env.example to .env.`);
  }
  return value;
};
const databasePort = process.env.POSTGRES_PORT ?? '5433';
const apiPort = process.env.API_PORT ?? '4000';
const databaseUrl = (role: string, passwordSetting: string) =>
  `postgres://dreamdevops_${role}:${encodeURIComponent(setting(passwordSetting))}@localhost:${databasePort}/dreamdevops`;

process.env.KEYCLOAK_ISSUER_URL ??= `http://localhost:${process.env.KEYCLOAK_PORT ?? '8081'}/realms/dreamdevops`;
process.env.KEYCLOAK_CLIENT_ID ??= 'dreamdevops-dashboard';
process.env.KEYCLOAK_CLIENT_SECRET ??= process.env.DREAMDEVOPS_KEYCLOAK_CLIENT_SECRET;
// The local stack can't send email, so users who register themselves stay unverified.
process.env.REQUIRE_VERIFIED_EMAIL ??= 'false';
process.env.API_DATABASE_URL = databaseUrl('app', 'DREAMDEVOPS_DB_APP_PASSWORD');
process.env.RELAY_DATABASE_URL = databaseUrl('relay', 'DREAMDEVOPS_DB_RELAY_PASSWORD');
process.env.JOBS_DATABASE_URL = databaseUrl('jobs', 'DREAMDEVOPS_DB_JOBS_PASSWORD');
// The local Forgejo administrator creates each company's Git organization.
process.env.FORGEJO_URL ??= `http://localhost:${process.env.FORGEJO_HTTP_PORT ?? '3000'}`;
process.env.FORGEJO_USERNAME ??= setting('FORGEJO_ADMIN_USERNAME');
process.env.FORGEJO_PASSWORD ??= setting('FORGEJO_ADMIN_PASSWORD');
process.env.API_PUBLIC_URL ??= `http://localhost:${apiPort}`;
process.env.DASHBOARD_URL ??= 'http://localhost:4200/';
// Browsers won't send Secure cookies over plain HTTP, which is all the local stack has.
process.env.SECURE_COOKIES ??= 'false';

// The demo company and its sample users. A failure doesn't stop the API, which seeds again next start.
if (process.env.SEED_DEMO_COMPANY !== 'false') {
  try {
    const { seedLocal } = await import('./seed-local.ts');
    await seedLocal();
  } catch (error) {
    console.warn(`The demo company wasn't seeded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await import(new URL('../dist/main.js', import.meta.url).href);
