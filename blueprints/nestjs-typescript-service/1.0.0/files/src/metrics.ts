import type { Meter } from '@opentelemetry/api';

/** What the service sends, read from the standard OpenTelemetry variables. */
export interface TelemetrySettings {
  /** Whether to send metrics. The platform asks for them, to show them on its dashboard. */
  readonly metrics: boolean;
  /** Whether to send traces, to a place of your own. */
  readonly traces: boolean;
  readonly exportIntervalMs: number;
}

const DEFAULT_EXPORT_INTERVAL_MS = 15_000;

/** Sends only what it's told where to send, so it sends nothing by default. */
export function telemetrySettings(env: NodeJS.ProcessEnv): TelemetrySettings {
  const interval = Number(env.OTEL_METRIC_EXPORT_INTERVAL || DEFAULT_EXPORT_INTERVAL_MS);
  return {
    metrics: Boolean(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT),
    traces: Boolean(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT),
    exportIntervalMs: Number.isInteger(interval) && interval > 0 ? interval : DEFAULT_EXPORT_INTERVAL_MS,
  };
}

/** The platform checks health every few seconds. That isn't traffic, so it isn't measured. */
export function isHealthCheck(url: string | undefined): boolean {
  return url?.startsWith('/health/') ?? false;
}

export interface ProcessUsage {
  /** CPU time used so far, in microseconds. */
  cpu(): { readonly user: number; readonly system: number };
  /** Memory held in RAM, in bytes. */
  memory(): number;
}

const THIS_PROCESS: ProcessUsage = {
  cpu: () => process.cpuUsage(),
  memory: () => process.memoryUsage.rss(),
};

/**
 * Reports the CPU time and memory the service uses, with their standard OpenTelemetry
 * names, so any tool that reads OpenTelemetry metrics, such as the platform, shows them.
 */
export function observeProcess(meter: Meter, usage: ProcessUsage = THIS_PROCESS): void {
  meter
    .createObservableCounter('process.cpu.time', { unit: 's', description: 'CPU time the process has used.' })
    .addCallback((result) => {
      const { user, system } = usage.cpu();
      result.observe(user / 1_000_000, { 'cpu.mode': 'user' });
      result.observe(system / 1_000_000, { 'cpu.mode': 'system' });
    });
  meter
    .createObservableUpDownCounter('process.memory.usage', { unit: 'By', description: 'Memory the process holds in RAM.' })
    .addCallback((result) => result.observe(usage.memory()));
}
