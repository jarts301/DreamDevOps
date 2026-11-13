// Starts the built API against the local stack, using the settings in infra/local/.env.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Forgejo's SSH host key, as the local target sees it through the gateway. Forgejo makes
 * its key on first start, so it's read from the running container.
 */
function forgejoKnownHosts(): string {
  try {
    const key = execFileSync(
      'docker',
      ['compose', '-f', fileURLToPath(new URL('../../../infra/local/compose.yaml', import.meta.url)), 'exec', '-T', 'forgejo', 'cat', '/data/ssh/ssh_host_ed25519_key.pub'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const [type, value] = key.split(/\s+/);
    return `[platform.internal]:2222 ${type} ${value}`;
  } catch {
    return '';
  }
}

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
// Applications send their metrics to Prometheus, which they reach through Docker's name
// for this machine, and the API reads them back for the Monitoring page.
const prometheusPort = process.env.PROMETHEUS_PORT ?? '9090';
process.env.PROMETHEUS_URL ??= `http://localhost:${prometheusPort}`;
process.env.APP_METRICS_OTLP_ENDPOINT ??= `http://host.docker.internal:${prometheusPort}/api/v1/otlp/v1/metrics`;
// Traces go to Jaeger the same way, and the API reads them back from its query API.
process.env.JAEGER_URL ??= `http://localhost:${process.env.JAEGER_PORT ?? '16686'}`;
process.env.APP_TRACES_OTLP_ENDPOINT ??= `http://host.docker.internal:${process.env.JAEGER_OTLP_PORT ?? '4318'}/v1/traces`;
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
// Forgejo and CI jobs run in Docker, where the API on this machine is host.docker.internal.
process.env.TOOLS_API_URL ??= `http://host.docker.internal:${apiPort}`;
// Browsers won't send Secure cookies over plain HTTP, which is all the local stack has.
process.env.SECURE_COOKIES ??= 'false';
// OpenBao keeps each environment's secrets; the platform's token is fixed by openbao-init.
process.env.OPENBAO_URL ??= `http://localhost:${process.env.OPENBAO_PORT ?? '8200'}`;
process.env.OPENBAO_TOKEN ??= process.env.OPENBAO_PLATFORM_TOKEN;
// The local target reaches the platform through its gateway, at platform.internal.
process.env.AGENT_API_URL ??= 'http://platform.internal:4000';
process.env.AGENT_CHART ??= 'oci://platform.internal:3000/dreamdevops-bot/charts/dreamdevops-agent';
process.env.TARGET_OPENBAO_URL ??= 'http://platform.internal:8200';
// By address: Kyverno checks signatures over plain HTTP only at private addresses.
process.env.TARGET_REGISTRY_HOST ??= '10.213.90.10:3000';
process.env.TARGET_GIT_SSH_URL ??= 'ssh://git@platform.internal:2222';
process.env.TARGET_GIT_KNOWN_HOSTS ??= forgejoKnownHosts();
// The demo company and its users, one for each role. See infra/local/README.md.
process.env.DEMO_DATA ??= 'true';

await import(new URL('../dist/main.js', import.meta.url).href);
