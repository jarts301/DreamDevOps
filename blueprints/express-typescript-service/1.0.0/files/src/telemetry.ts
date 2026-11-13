// Starts OpenTelemetry before the service loads, so its HTTP traffic is measured and traced.
// It sends nothing unless told where, with the standard OTEL_EXPORTER_OTLP_* variables.
// The platform sets the ones for metrics and traces, so it can show them on its dashboard.
import { register } from 'node:module';
import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
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
    instrumentations: [
      // Measures and traces every request the service answers, with its duration and
      // status, which give requests, response times and errors. It continues the trace a
      // caller started, from its traceparent header.
      new HttpInstrumentation({ ignoreIncomingRequestHook: (request) => isHealthCheck(request.url) }),
      // Traces the requests the service makes with fetch, and sends each one the trace, so
      // the services it calls continue it.
      new UndiciInstrumentation(),
    ],
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
