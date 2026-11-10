// Starts the built API against the local stack, using the settings in infra/local/.env.
const password = process.env.DREAMDEVOPS_DB_APP_PASSWORD;
if (password === undefined) {
  throw new Error('DREAMDEVOPS_DB_APP_PASSWORD is not set. See infra/local/README.md.');
}
const databasePort = process.env.POSTGRES_PORT ?? '5433';
const apiPort = process.env.API_PORT ?? '4000';

const roleUrl = (role: string, variable: string) =>
  `postgres://dreamdevops_${role}:${encodeURIComponent(process.env[variable] ?? '')}@localhost:${databasePort}/dreamdevops`;
process.env.RELAY_DATABASE_URL ??= roleUrl('relay', 'DREAMDEVOPS_DB_RELAY_PASSWORD');
process.env.JOBS_DATABASE_URL ??= roleUrl('jobs', 'DREAMDEVOPS_DB_JOBS_PASSWORD');
process.env.FORGEJO_URL ??= `http://localhost:${process.env.FORGEJO_HTTP_PORT ?? '3000'}`;
process.env.FORGEJO_BOT_USERNAME ??= 'dreamdevops-bot';
// Forgejo runs in Docker, so it reaches the API on this machine through Docker's name for it.
process.env.FORGEJO_WEBHOOK_URL ??= `http://host.docker.internal:${apiPort}/api/v1/hooks/forgejo`;
// Mailpit catches every email locally and sends nothing out.
process.env.SMTP_HOST ??= 'localhost';
process.env.SMTP_PORT ??= process.env.MAILPIT_SMTP_PORT ?? '1025';
process.env.SMTP_SECURITY ??= 'none';
process.env.SMTP_FROM ??= 'DreamDevOps <no-reply@example.com>';
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
// A sample company with a sample account in each role. Set SAMPLE_DATA=off in .env to skip it.
process.env.SAMPLE_DATA ??= 'on';

await import(new URL('../dist/main.js', import.meta.url).href);
