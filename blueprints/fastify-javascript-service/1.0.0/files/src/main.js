import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { shutdownTelemetry } from './telemetry.js';

const config = loadConfig(process.env);
const app = buildApp({ logger: true, corsOrigins: config.corsOrigins });

// Finishes requests in progress before stopping, so deployments don't drop traffic.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void app
      .close()
      .then(shutdownTelemetry)
      .finally(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
