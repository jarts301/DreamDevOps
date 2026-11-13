// Starts OpenTelemetry before the service loads, so its HTTP traffic is measured.
// It sends nothing unless told where, with the standard OTEL_EXPORTER_OTLP_* variables.
// The platform sets the one for metrics, so it can show them on its dashboard.
import { register } from 'node:module';
import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { isHealthCheck, observeProcess, telemetrySettings } from './metrics.ts';

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? '__APP_SLUG__';
const settings = telemetrySettings(process.env);

let sdk: NodeSDK | undefined;

if (settings.metrics || settings.traces) {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  sdk = new NodeSDK({
    serviceName: SERVICE_NAME,
    // Each signal goes only where it's asked for. An empty list sends none.
    ...(settings.traces ? { traceExporter: new OTLPTraceExporter() } : { spanProcessors: [] }),
    metricReaders: settings.metrics
      ? [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: settings.exportIntervalMs })]
      : [],
    // Logs go to standard output, where the platform reads them.
    logRecordProcessors: [],
    // Measures every request's duration and status, which give requests, response times and errors.
    instrumentations: [new HttpInstrumentation({ ignoreIncomingRequestHook: (request) => isHealthCheck(request.url) })],
  });
  sdk.start();
  if (settings.metrics) {
    observeProcess(metrics.getMeter(SERVICE_NAME));
  }
}

/** Sends any telemetry still waiting, before the process stops. */
export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown();
}
