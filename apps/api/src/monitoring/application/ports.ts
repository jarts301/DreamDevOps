import type { MetricKey, MetricValues } from '../domain/metrics.ts';

/** Provides the MetricsStore, or null when this server keeps no metrics. */
export const METRICS_STORE = Symbol('METRICS_STORE');

export interface Point {
  readonly at: Date;
  readonly value: number;
}

export interface MetricsWindow {
  readonly start: Date;
  readonly end: Date;
  readonly stepSeconds: number;
}

/**
 * Where applications' metrics are kept. Environments are named by their IDs, which every
 * metric carries, so a store never answers for environments it wasn't asked about.
 */
export interface MetricsStore {
  /** Each environment's latest values, for those that sent any recently. */
  latest(environmentIds: readonly string[]): Promise<ReadonlyMap<string, MetricValues>>;
  /** One environment's metrics over a window, one point per step, with gaps where it sent nothing. */
  series(environmentId: string, window: MetricsWindow): Promise<Readonly<Record<MetricKey, readonly Point[]>>>;
}

/** The store can't be reached, or answered with something it shouldn't. The message is safe to show. */
export class MetricsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricsUnavailableError';
  }
}
