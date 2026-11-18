/** Monitoring's published language: the metrics it shows, and how their values read. */

export type MetricKey = 'cpu' | 'memory' | 'requests' | 'responseTime' | 'errors';

/** How a metric's values read: a share in percent, bytes, a count each second, or seconds. */
export type MetricUnit = 'percent' | 'bytes' | 'per-second' | 'seconds';

export interface MetricDefinition {
  readonly key: MetricKey;
  readonly name: string;
  readonly unit: MetricUnit;
  readonly description: string;
}

/**
 * The metrics shown for every running application, in the order they're shown. Each one
 * is what applications send over OpenTelemetry, with its standard name, so any
 * application that sends them shows up, whichever blueprint it started from.
 */
export const METRICS: readonly MetricDefinition[] = [
  { key: 'cpu', name: 'CPU', unit: 'percent', description: 'How much of one CPU core it uses, in its busiest copy.' },
  { key: 'memory', name: 'Memory', unit: 'bytes', description: 'How much memory it holds, in its busiest copy.' },
  { key: 'requests', name: 'Requests', unit: 'per-second', description: 'HTTP requests it answers each second.' },
  {
    key: 'responseTime',
    name: 'Response time',
    unit: 'seconds',
    description: 'The time within which it answers 95% of requests.',
  },
  { key: 'errors', name: 'Server errors', unit: 'percent', description: 'The share of requests it answers with a 5xx error.' },
];

export const METRIC_KEYS: readonly MetricKey[] = METRICS.map((metric) => metric.key);

/** A metric's definition, by its key. */
export function metricOf(key: MetricKey): MetricDefinition {
  return METRICS.find((metric) => metric.key === key)!;
}

export function isMetricKey(value: unknown): value is MetricKey {
  return typeof value === 'string' && (METRIC_KEYS as readonly string[]).includes(value);
}

const MEBIBYTE = 1024 * 1024;

/**
 * Shows a value in its metric's unit, such as 12.5%, 48.2 MiB, 3.1/s or 120 ms, as the
 * dashboard does. Memory is in MiB, as containers' limits are.
 */
export function formatMetricValue(value: number | null, unit: MetricUnit): string {
  if (value === null) {
    return 'No data';
  }
  switch (unit) {
    case 'percent':
      return `${round(value)}%`;
    case 'bytes':
      return value >= 1024 * MEBIBYTE ? `${(value / (1024 * MEBIBYTE)).toFixed(2)} GiB` : `${(value / MEBIBYTE).toFixed(1)} MiB`;
    case 'per-second':
      return `${round(value)}/s`;
    case 'seconds':
      return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`;
  }
}

/** Fewer decimals as numbers grow, so small values don't read as zero and large ones stay short. */
function round(value: number): string {
  if (value === 0) {
    return '0';
  }
  if (Math.abs(value) >= 10) {
    return String(Math.round(value));
  }
  return Math.abs(value) >= 1 ? value.toFixed(1) : value.toFixed(2);
}

/** Each metric's value, or null where the application sent nothing to work it out from. */
export type MetricValues = Readonly<Record<MetricKey, number | null>>;

export const NO_VALUES: MetricValues = { cpu: null, memory: null, requests: null, responseTime: null, errors: null };
