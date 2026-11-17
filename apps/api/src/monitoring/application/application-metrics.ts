import { MonitoringError } from '../domain/errors.ts';
import {
  dailyHighWindow,
  type MetricDefinition,
  METRICS,
  type MetricValues,
  NO_VALUES,
  parseRange,
  type TimeRangeKey,
  windowOf,
} from '../domain/metrics.ts';
import { type MetricsStore, MetricsUnavailableError } from './ports.ts';
import type { RunningPlace, RunningPlaces } from './running-places.ts';

const NOT_SET_UP = 'This server doesn’t keep applications’ metrics. An administrator can set it up with PROMETHEUS_URL.';

/** An application that runs in an environment, as the monitoring page lists it. */
export interface MonitoredEnvironment {
  /** The place: this application in this environment. Routes name it by this. */
  readonly placeId: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly applicationId: string;
  readonly applicationName: string;
  readonly production: boolean;
  readonly version: string | null;
  readonly since: string | null;
  readonly address: string | null;
  /** What runs the environment, such as kubernetes, or local for This machine. */
  readonly provider: string | null;
  /** What its container may use at most, to set its CPU and memory against, or null when unknown. */
  readonly limits: { readonly cpus: number; readonly memoryBytes: number } | null;
}

export interface MonitoringOverview {
  /** Whether this server keeps applications' metrics at all. */
  readonly enabled: boolean;
  /** Why the metrics couldn't be read just now, if they couldn't. The environments are listed anyway. */
  readonly problem: string | null;
  readonly metrics: readonly MetricDefinition[];
  /** Each application that runs in an environment, with its latest metrics. */
  readonly environments: readonly (MonitoredEnvironment & { readonly latest: MetricValues })[];
}

export interface MetricSeries extends MetricDefinition {
  /** One point per step, oldest first. Steps where the application sent nothing have no point. */
  readonly points: readonly { readonly at: string; readonly value: number }[];
  /**
   * The highest value in the day before the range, what's been normal lately, or null when
   * the application sent nothing then. Values above it are higher than any that day.
   */
  readonly dailyHigh: number | null;
}

export interface EnvironmentMetrics {
  readonly environment: MonitoredEnvironment;
  readonly range: { readonly key: TimeRangeKey; readonly start: string; readonly end: string; readonly stepSeconds: number };
  /** The day each series' daily high comes from: the 24 hours before the range. */
  readonly dailyHigh: { readonly start: string; readonly end: string };
  readonly series: readonly MetricSeries[];
}

/**
 * The metrics of what runs in the company's environments: CPU, memory, requests,
 * response times and server errors, as the applications send them. Only the current
 * company's places are ever asked about, so no company sees another's metrics.
 */
export class ApplicationMetrics {
  readonly #places: RunningPlaces;
  readonly #store: MetricsStore | null;
  readonly #now: () => Date;

  constructor(places: RunningPlaces, store: MetricsStore | null, now: () => Date = () => new Date()) {
    this.#places = places;
    this.#store = store;
    this.#now = now;
  }

  /** Every environment a version runs in, by application, with its latest metrics. */
  async overview(): Promise<MonitoringOverview> {
    const running = await this.#places.list();
    let latest: ReadonlyMap<string, MetricValues> = new Map();
    let problem: string | null = null;
    if (this.#store !== null && running.length > 0) {
      try {
        latest = await this.#store.latest(running.map((place) => place.placeId));
      } catch (error) {
        if (!(error instanceof MetricsUnavailableError)) {
          throw error;
        }
        // The list is still worth seeing, so the page says why the numbers are missing.
        problem = error.message;
      }
    }
    const environments = running
      .map((place) => ({ ...monitored(place), latest: latest.get(place.placeId) ?? NO_VALUES }))
      .sort(
        (left, right) =>
          left.applicationName.localeCompare(right.applicationName) ||
          Number(left.production) - Number(right.production) ||
          left.environmentName.localeCompare(right.environmentName),
      );
    return { enabled: this.#store !== null, problem, metrics: METRICS, environments };
  }

  /** One place's metrics over a range, such as the last hour, for charts. */
  async environment(idValue: unknown, rangeValue: unknown): Promise<EnvironmentMetrics> {
    const range = parseRange(rangeValue);
    const environment = await this.#places.find(idValue);
    if (environment === null) {
      throw new MonitoringError('not-found', 'Nothing of yours runs there.');
    }
    if (this.#store === null) {
      throw new MonitoringError('unavailable', NOT_SET_UP);
    }
    const window = windowOf(range, this.#now());
    let series;
    try {
      series = await this.#store.series(environment.placeId, window);
    } catch (error) {
      if (error instanceof MetricsUnavailableError) {
        throw new MonitoringError('unavailable', error.message);
      }
      throw error;
    }
    return {
      environment: monitored(environment),
      range: {
        key: range.key,
        start: window.start.toISOString(),
        end: window.end.toISOString(),
        stepSeconds: window.stepSeconds,
      },
      dailyHigh: { start: dailyHighWindow(window).start.toISOString(), end: window.start.toISOString() },
      series: METRICS.map((metric) => ({
        ...metric,
        points: (series[metric.key]?.points ?? []).map((point) => ({ at: point.at.toISOString(), value: point.value })),
        dailyHigh: series[metric.key]?.dailyHigh ?? null,
      })),
    };
  }
}

function monitored(place: RunningPlace): MonitoredEnvironment {
  return {
    placeId: place.placeId,
    environmentId: place.environmentId,
    environmentName: place.environmentName,
    applicationId: place.applicationId,
    applicationName: place.applicationName,
    production: place.production,
    version: place.version,
    since: place.since,
    address: place.address,
    provider: place.provider,
    limits: place.limits,
  };
}

