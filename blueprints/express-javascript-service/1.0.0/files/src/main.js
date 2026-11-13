import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { shutdownTelemetry } from './telemetry.js';

const config = loadConfig(process.env);
const server = buildApp({ logger: true, corsOrigins: config.corsOrigins }).listen(config.port, config.host);

// Finishes requests in progress before stopping, so deployments don't drop traffic.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    server.close(() => {
      void shutdownTelemetry().finally(() => process.exit(0));
    });
  });
}
