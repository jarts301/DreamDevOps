import type { MetricValues } from '../domain/metrics.ts';

/** Provides LatestMetrics to other contexts. */
export const LATEST_METRICS = Symbol('LATEST_METRICS');

/**
 * The latest metrics of environments, or why there are none: the server keeps no
 * metrics, or its metrics store couldn't answer just now.
 */
export type LatestMetricsAnswer =
  | {
      readonly status: 'ok';
      /**
       * Each environment's latest values, by its ID, for those that run a version and sent
       * metrics in the last two minutes. Any other environment asked about is left out.
       */
      readonly values: ReadonlyMap<string, MetricValues>;
    }
  | { readonly status: 'not-set-up' }
  | { readonly status: 'unavailable'; readonly problem: string };

/**
 * Monitoring's published query of what environments use now, for contexts that watch
 * metrics, such as Alerts. It runs in the current company, and only ever asks the metrics
 * store about that company's environments, whichever IDs it's given.
 */
export interface LatestMetrics {
  /** Whether this server keeps applications' metrics at all. */
  readonly enabled: boolean;
  of(environmentIds: readonly string[]): Promise<LatestMetricsAnswer>;
}
