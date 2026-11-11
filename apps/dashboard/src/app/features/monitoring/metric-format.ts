import type { MetricUnit } from './monitoring.api';

/** Shows a metric's value in its unit, such as 12.5%, 48.2 MB, 3.1/s or 120 ms. */
export function formatMetric(value: number | null, unit: MetricUnit): string {
  if (value === null) {
    return 'No data';
  }
  switch (unit) {
    case 'percent':
      return `${round(value)}%`;
    case 'bytes':
      return `${(value / 1_000_000).toFixed(1)} MB`;
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

/** A span's or trace's length, such as 0.4 ms, 84 ms or 1.25 s. */
export function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)} s`;
  }
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}
