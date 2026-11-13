import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { shutdownTelemetry } from './telemetry.ts';

const config = loadConfig(process.env);
const app = buildApp({ logger: true });

// Finishes requests in progress before stopping, so deployments don't drop traffic.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(shutdownTelemetry)
      .finally(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
