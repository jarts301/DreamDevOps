// Starts OpenTelemetry before the service loads, so its HTTP traffic is traced.
// It sends nothing unless OTEL_EXPORTER_OTLP_ENDPOINT is set, which the platform does.
import { register } from 'node:module';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

let sdk: NodeSDK | undefined;

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? '__APP_SLUG__',
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
    instrumentations: [new HttpInstrumentation()],
  });
  sdk.start();
}

/** Sends any telemetry still waiting, before the process stops. */
export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown();
}
