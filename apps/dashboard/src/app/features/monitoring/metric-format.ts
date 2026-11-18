import type { ContainerLimits, MetricKey } from './monitoring.api';

const MEBIBYTE = 1024 * 1024;

/**
 * Shows a metric's value in its unit, such as 12.5%, 48.2 MiB, 3.1/s or 120 ms, as the API
 * words it in alert emails. Memory is in MiB, as containers' limits are, so it reads against them.
 */
export { formatMetricValue as formatMetric } from '@dreamdevops/contracts/monitoring/metrics';

/** A span's or trace's length, such as 0.4 ms, 84 ms or 1.25 s. */
export function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)} s`;
  }
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

/** A container's limit for a metric, in the metric's unit, such as 100 (%) for one CPU, or null when it has none. */
export function limitFor(key: MetricKey, limits: ContainerLimits | null): number | null {
  if (limits === null) {
    return null;
  }
  if (key === 'cpu') {
    return limits.cpus * 100;
  }
  return key === 'memory' ? limits.memoryBytes : null;
}

/** A container's limit for a metric, in words, such as 1 CPU or 512 MiB. */
export function formatLimit(key: MetricKey, limits: ContainerLimits | null): string | null {
  const limit = limitFor(key, limits);
  if (limit === null) {
    return null;
  }
  if (key === 'cpu') {
    const cpus = Number((limit / 100).toFixed(2));
    return `${cpus} ${cpus === 1 ? 'CPU' : 'CPUs'}`;
  }
  const mebibytes = limit / MEBIBYTE;
  return mebibytes >= 1024 ? `${Number((mebibytes / 1024).toFixed(2))} GiB` : `${Number(mebibytes.toFixed(1))} MiB`;
}

/** How much of its limit a value uses, from 0 to 1 or more, or null when there's no value or no limit. */
export function shareOfLimit(value: number | null, key: MetricKey, limits: ContainerLimits | null): number | null {
  const limit = limitFor(key, limits);
  return value === null || limit === null || limit <= 0 ? null : value / limit;
}

/** From this share of its limit on, a value is close enough to stand out. */
export const NEAR_LIMIT = 0.9;
