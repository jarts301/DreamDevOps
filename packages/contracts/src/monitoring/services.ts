import type { MetricValues } from './metrics.ts';

/** What Monitoring answers for other contexts. */

/**
 * The latest metrics of places, each one application in one environment, or why there are
 * none: the server keeps no metrics, or its metrics store couldn't answer just now.
 */
export type LatestMetricsAnswer =
  | {
      readonly status: 'ok';
      /**
       * Each place's latest values, by its ID, for those that run a version and sent
       * metrics in the last two minutes. Any other place asked about is left out.
       */
      readonly values: ReadonlyMap<string, MetricValues>;
    }
  | { readonly status: 'not-set-up' }
  | { readonly status: 'unavailable'; readonly problem: string };

export const LATEST_METRICS = Symbol('LATEST_METRICS');

/**
 * The latest metrics of what runs, for contexts that watch them, such as Alerts. It runs in
 * the current company, and only ever asks the metrics store about that company's places,
 * whichever IDs it's given.
 */
export interface LatestMetrics {
  /** Whether this server keeps applications' metrics at all. */
  readonly enabled: boolean;
  of(placeIds: readonly string[]): Promise<LatestMetricsAnswer>;
}
