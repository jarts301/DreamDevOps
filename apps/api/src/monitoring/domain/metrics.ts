import type { TimeRangeKey } from '@dreamdevops/contracts/monitoring/http';
import { MonitoringError } from './errors.ts';

// The metrics are Monitoring's published language, kept in its contracts.
export {
  formatMetricValue,
  isMetricKey,
  type MetricDefinition,
  type MetricKey,
  METRIC_KEYS,
  metricOf,
  METRICS,
  type MetricUnit,
  type MetricValues,
  NO_VALUES,
} from '@dreamdevops/contracts/monitoring/metrics';

export type { TimeRangeKey } from '@dreamdevops/contracts/monitoring/http';

export interface TimeRange {
  readonly key: TimeRangeKey;
  readonly seconds: number;
  /** The time between two points of a chart, so every range has about 60. */
  readonly stepSeconds: number;
}

export const TIME_RANGES: Readonly<Record<TimeRangeKey, TimeRange>> = {
  '15m': { key: '15m', seconds: 15 * 60, stepSeconds: 15 },
  '1h': { key: '1h', seconds: 60 * 60, stepSeconds: 60 },
  '6h': { key: '6h', seconds: 6 * 60 * 60, stepSeconds: 6 * 60 },
  '24h': { key: '24h', seconds: 24 * 60 * 60, stepSeconds: 24 * 60 },
};

/** The range to show, one hour unless another is asked for. */
export function parseRange(value: unknown): TimeRange {
  if (value === undefined || value === '') {
    return TIME_RANGES['1h'];
  }
  if (typeof value === 'string' && Object.hasOwn(TIME_RANGES, value)) {
    return TIME_RANGES[value as TimeRangeKey];
  }
  throw new MonitoringError('invalid', `Choose a range of ${Object.keys(TIME_RANGES).join(', ')}.`);
}

/**
 * The window a chart covers, ending at the last whole step before now, so everyone who
 * looks in the same step sees the same points.
 */
export function windowOf(range: TimeRange, now: Date): { readonly start: Date; readonly end: Date; readonly stepSeconds: number } {
  const stepMs = range.stepSeconds * 1000;
  const end = Math.floor(now.getTime() / stepMs) * stepMs;
  return { start: new Date(end - range.seconds * 1000), end: new Date(end), stepSeconds: range.stepSeconds };
}

/** How far back the daily high looks: a day, before the range a chart shows. */
export const DAILY_HIGH_SECONDS = 24 * 60 * 60;

/**
 * The day a chart's values are measured against: the 24 hours before its range starts. Its
 * highest value is what's been normal lately, and the range's values can go above it,
 * which they couldn't if the day included them.
 */
export function dailyHighWindow(window: { readonly start: Date }): { readonly start: Date; readonly end: Date } {
  return { start: new Date(window.start.getTime() - DAILY_HIGH_SECONDS * 1000), end: window.start };
}
