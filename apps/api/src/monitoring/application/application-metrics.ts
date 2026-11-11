import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import type { RunningEnvironment, RunningEnvironments } from '../../environments/application/running-environments.ts';
import { MonitoringError } from '../domain/errors.ts';
import {
  type MetricDefinition,
  METRICS,
  type MetricValues,
  NO_VALUES,
  parseRange,
  type TimeRangeKey,
  windowOf,
} from '../domain/metrics.ts';
import { type MetricsStore, MetricsUnavailableError } from './ports.ts';

const NOT_SET_UP = 'This server doesn’t keep applications’ metrics. An administrator can set it up with PROMETHEUS_URL.';

/** An environment that runs a version, as the monitoring page lists it. */
export interface MonitoredEnvironment {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly applicationId: string;
  readonly applicationName: string;
  readonly production: boolean;
  readonly version: string | null;
  readonly since: string | null;
  readonly address: string | null;
  readonly targetName: string | null;
  /** What its container may use at most, to set its CPU and memory against, or null when unknown. */
  readonly limits: { readonly cpus: number; readonly memoryBytes: number } | null;
}

export interface MonitoringOverview {
  /** Whether this server keeps applications' metrics at all. */
  readonly enabled: boolean;
  /** Why the metrics couldn't be read just now, if they couldn't. The environments are listed anyway. */
  readonly problem: string | null;
  readonly metrics: readonly MetricDefinition[];
  /** Each environment a version runs in, with its latest metrics. */
  readonly environments: readonly (MonitoredEnvironment & { readonly latest: MetricValues })[];
}

export interface MetricSeries extends MetricDefinition {
  /** One point per step, oldest first. Steps where the application sent nothing have no point. */
  readonly points: readonly { readonly at: string; readonly value: number }[];
}

export interface EnvironmentMetrics {
  readonly environment: MonitoredEnvironment;
  readonly range: { readonly key: TimeRangeKey; readonly start: string; readonly end: string; readonly stepSeconds: number };
  readonly series: readonly MetricSeries[];
}

/**
 * The metrics of what runs in the company's environments: CPU, memory, requests,
 * response times and server errors, as the applications send them. Only the current
 * company's environments are ever asked about, so no company sees another's metrics.
 */
export class ApplicationMetrics {
  readonly #environments: RunningEnvironments;
  readonly #catalog: ApplicationCatalog;
  readonly #store: MetricsStore | null;
  readonly #now: () => Date;

  constructor(
    environments: RunningEnvironments,
    catalog: ApplicationCatalog,
    store: MetricsStore | null,
    now: () => Date = () => new Date(),
  ) {
    this.#environments = environments;
    this.#catalog = catalog;
    this.#store = store;
    this.#now = now;
  }

  /** Every environment a version runs in, by application, with its latest metrics. */
  async overview(): Promise<MonitoringOverview> {
    const running = await this.#environments.list();
    const names = await this.#applicationNames(running);
    let latest: ReadonlyMap<string, MetricValues> = new Map();
    let problem: string | null = null;
    if (this.#store !== null && running.length > 0) {
      try {
        latest = await this.#store.latest(running.map((environment) => environment.environmentId));
      } catch (error) {
        if (!(error instanceof MetricsUnavailableError)) {
          throw error;
        }
        // The list is still worth seeing, so the page says why the numbers are missing.
        problem = error.message;
      }
    }
    const environments = running
      .map((environment) => ({
        ...monitored(environment, names.get(environment.applicationId) ?? ''),
        latest: latest.get(environment.environmentId) ?? NO_VALUES,
      }))
      .sort(
        (left, right) =>
          left.applicationName.localeCompare(right.applicationName) ||
          Number(left.production) - Number(right.production) ||
          left.environmentName.localeCompare(right.environmentName),
      );
    return { enabled: this.#store !== null, problem, metrics: METRICS, environments };
  }

  /** One environment's metrics over a range, such as the last hour, for charts. */
  async environment(idValue: unknown, rangeValue: unknown): Promise<EnvironmentMetrics> {
    const range = parseRange(rangeValue);
    const environment = typeof idValue === 'string' ? await this.#environments.find(idValue) : null;
    if (environment === null) {
      throw new MonitoringError('not-found', 'There’s no such environment.');
    }
    if (this.#store === null) {
      throw new MonitoringError('unavailable', NOT_SET_UP);
    }
    const window = windowOf(range, this.#now());
    let series;
    try {
      series = await this.#store.series(environment.environmentId, window);
    } catch (error) {
      if (error instanceof MetricsUnavailableError) {
        throw new MonitoringError('unavailable', error.message);
      }
      throw error;
    }
    const application = await this.#catalog.get(environment.applicationId);
    return {
      environment: monitored(environment, application.name),
      range: {
        key: range.key,
        start: window.start.toISOString(),
        end: window.end.toISOString(),
        stepSeconds: window.stepSeconds,
      },
      series: METRICS.map((metric) => ({
        ...metric,
        points: (series[metric.key] ?? []).map((point) => ({ at: point.at.toISOString(), value: point.value })),
      })),
    };
  }

  /** The names of the applications these environments belong to, archived ones included. */
  async #applicationNames(environments: readonly RunningEnvironment[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (environments.length === 0) {
      return names;
    }
    for (const application of await this.#catalog.list('active')) {
      names.set(application.id, application.name);
    }
    const missing = [...new Set(environments.map((environment) => environment.applicationId))].filter((id) => !names.has(id));
    for (const application of await Promise.all(missing.map((id) => this.#catalog.get(id)))) {
      names.set(application.id, application.name);
    }
    return names;
  }
}

function monitored(environment: RunningEnvironment, applicationName: string): MonitoredEnvironment {
  return {
    environmentId: environment.environmentId,
    environmentName: environment.environmentName,
    applicationId: environment.applicationId,
    applicationName,
    production: environment.production,
    version: environment.version,
    since: environment.since,
    address: environment.address,
    targetName: environment.targetName,
    limits: environment.limits,
  };
}

