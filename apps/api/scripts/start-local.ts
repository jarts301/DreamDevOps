// Starts the built API against the local stack, using the settings in infra/local/.env.
const password = process.env.DREAMDEVOPS_DB_APP_PASSWORD;
if (password === undefined) {
  throw new Error('DREAMDEVOPS_DB_APP_PASSWORD is not set. See infra/local/README.md.');
}
const databasePort = process.env.POSTGRES_PORT ?? '5433';
const apiPort = process.env.API_PORT ?? '4000';

process.env.KEYCLOAK_ISSUER_URL ??= `http://localhost:${process.env.KEYCLOAK_PORT ?? '8081'}/realms/dreamdevops`;
process.env.KEYCLOAK_CLIENT_ID ??= 'dreamdevops-dashboard';
process.env.KEYCLOAK_CLIENT_SECRET ??= process.env.DREAMDEVOPS_KEYCLOAK_CLIENT_SECRET;
// The local stack can't send email, so users who register themselves stay unverified.
process.env.REQUIRE_VERIFIED_EMAIL ??= 'false';
process.env.API_DATABASE_URL = `postgres://dreamdevops_app:${encodeURIComponent(password)}@localhost:${databasePort}/dreamdevops`;
process.env.API_PUBLIC_URL ??= `http://localhost:${apiPort}`;
process.env.DASHBOARD_URL ??= 'http://localhost:4200/';
// Browsers won't send Secure cookies over plain HTTP, which is all the local stack has.
process.env.SECURE_COOKIES ??= 'false';

await import(new URL('../dist/main.js', import.meta.url).href);
