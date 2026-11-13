import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { shutdownTelemetry } from './telemetry.ts';

const config = loadConfig(process.env);
const server = buildApp({ logger: true, corsOrigins: config.corsOrigins }).listen(config.port, config.host);

// Finishes requests in progress before stopping, so deployments don't drop traffic.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(() => {
      void shutdownTelemetry().finally(() => process.exit(0));
    });
  });
}
