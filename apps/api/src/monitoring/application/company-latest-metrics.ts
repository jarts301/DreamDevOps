import type { RunningEnvironments } from '../../environments/application/running-environments.ts';
import type { MetricValues } from '../domain/metrics.ts';
import type { LatestMetrics, LatestMetricsAnswer } from './latest-metrics.ts';
import { type MetricsStore, MetricsUnavailableError } from './ports.ts';

/**
 * Answers LatestMetrics from the metrics store. The IDs it's given are checked against
 * what runs in the current company first, so another company's environment is never
 * asked about, even by mistake.
 */
export class CompanyLatestMetrics implements LatestMetrics {
  readonly #environments: RunningEnvironments;
  readonly #store: MetricsStore | null;

  constructor(environments: RunningEnvironments, store: MetricsStore | null) {
    this.#environments = environments;
    this.#store = store;
  }

  get enabled(): boolean {
    return this.#store !== null;
  }

  async of(environmentIds: readonly string[]): Promise<LatestMetricsAnswer> {
    if (this.#store === null) {
      return { status: 'not-set-up' };
    }
    if (environmentIds.length === 0) {
      return { status: 'ok', values: new Map<string, MetricValues>() };
    }
    const asked = new Set(environmentIds);
    const ours = (await this.#environments.list())
      .map((environment) => environment.environmentId)
      .filter((id) => asked.has(id));
    if (ours.length === 0) {
      return { status: 'ok', values: new Map<string, MetricValues>() };
    }
    try {
      const latest = await this.#store.latest(ours);
      return { status: 'ok', values: new Map([...latest].filter(([id]) => ours.includes(id))) };
    } catch (error) {
      if (error instanceof MetricsUnavailableError) {
        return { status: 'unavailable', problem: error.message };
      }
      throw error;
    }
  }
}
