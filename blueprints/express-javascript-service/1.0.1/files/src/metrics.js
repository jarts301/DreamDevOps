/**
 * What the service sends, read from the standard OpenTelemetry variables.
 * @typedef {object} TelemetrySettings
 * @property {boolean} metrics Whether to send metrics. The platform asks for them, to show them on its dashboard.
 * @property {boolean} traces Whether to send traces.
 * @property {number} exportIntervalMs
 */

const DEFAULT_EXPORT_INTERVAL_MS = 15_000;

/**
 * Sends only what it's told where to send, so it sends nothing by default.
 * @param {NodeJS.ProcessEnv} env
 * @returns {TelemetrySettings}
 */
export function telemetrySettings(env) {
  const interval = Number(env.OTEL_METRIC_EXPORT_INTERVAL || DEFAULT_EXPORT_INTERVAL_MS);
  return {
    metrics: Boolean(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT),
    traces: Boolean(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT),
    exportIntervalMs: Number.isInteger(interval) && interval > 0 ? interval : DEFAULT_EXPORT_INTERVAL_MS,
  };
}

/**
 * The platform checks health every few seconds. That isn't traffic, so it isn't measured.
 * @param {string | undefined} url
 * @returns {boolean}
 */
export function isHealthCheck(url) {
  return url?.startsWith('/health/') ?? false;
}

/**
 * How much CPU and memory the process uses.
 * @typedef {object} ProcessUsage
 * @property {() => { user: number, system: number }} cpu CPU time used so far, in microseconds.
 * @property {() => number} memory Memory held in RAM, in bytes.
 */

/** @type {ProcessUsage} */
const THIS_PROCESS = {
  cpu: () => process.cpuUsage(),
  memory: () => process.memoryUsage.rss(),
};

/**
 * Reports the CPU time and memory the service uses, with their standard OpenTelemetry
 * names, so any tool that reads OpenTelemetry metrics, such as the platform, shows them.
 * @param {import('@opentelemetry/api').Meter} meter
 * @param {ProcessUsage} [usage]
 */
export function observeProcess(meter, usage = THIS_PROCESS) {
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
