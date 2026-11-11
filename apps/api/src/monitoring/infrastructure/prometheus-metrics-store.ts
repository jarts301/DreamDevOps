import { isUuid } from '@dreamdevops/shared-kernel';
import { ENVIRONMENT_ATTRIBUTE } from '../../environments/domain/telemetry.ts';
import { METRIC_KEYS, type MetricKey, type MetricValues } from '../domain/metrics.ts';
import { type MetricsStore, MetricsUnavailableError, type MetricsWindow, type Point } from '../application/ports.ts';

export interface PrometheusOptions {
  /** Such as http://localhost:9090. */
  readonly url: string;
  readonly timeoutMs?: number;
  /** Makes HTTP requests. Tests pass their own. */
  readonly fetch?: typeof fetch;
}

/**
 * Prometheus names the environment's resource attribute this way when metrics arrive
 * over OTLP, because it promotes it to a label, as infra/local/prometheus asks.
 */
export const ENVIRONMENT_LABEL = ENVIRONMENT_ATTRIBUTE.replace(/[^A-Za-z0-9_]/g, '_');

/** The smallest window a rate is worked out over, so it always spans a few of an application's exports. */
const MIN_RATE_WINDOW_SECONDS = 120;

const HTTP_DURATION = 'http_server_request_duration_seconds';

/**
 * Each metric as PromQL, for a label selector and a rate window. The names are how
 * Prometheus stores the standard OpenTelemetry metrics: process.cpu.time,
 * process.memory.usage and http.server.request.duration.
 */
const QUERIES: Readonly<Record<MetricKey, (selector: string, window: string) => string>> = {
  cpu: (selector, window) => `sum by (${ENVIRONMENT_LABEL}) (rate(process_cpu_time_seconds_total{${selector}}[${window}])) * 100`,
  memory: (selector) => `sum by (${ENVIRONMENT_LABEL}) (process_memory_usage_bytes{${selector}})`,
  requests: (selector, window) => `sum by (${ENVIRONMENT_LABEL}) (rate(${HTTP_DURATION}_count{${selector}}[${window}]))`,
  responseTime: (selector, window) =>
    `histogram_quantile(0.95, sum by (${ENVIRONMENT_LABEL}, le) (rate(${HTTP_DURATION}_bucket{${selector}}[${window}])))`,
  // With no 5xx answers there's no such series, so those count as none, rather than as unknown.
  errors: (selector, window) => {
    const all = `sum by (${ENVIRONMENT_LABEL}) (rate(${HTTP_DURATION}_count{${selector}}[${window}]))`;
    const failed = `sum by (${ENVIRONMENT_LABEL}) (rate(${HTTP_DURATION}_count{${selector},http_response_status_code=~"5.."}[${window}]))`;
    return `(${failed} or ${all} * 0) / ${all} * 100`;
  },
};

interface PrometheusAnswer {
  status?: string;
  error?: string;
  data?: {
    resultType?: string;
    result?: { metric?: Record<string, string>; value?: [number, string]; values?: [number, string][] }[];
  };
}

/**
 * Reads applications' metrics from Prometheus, which receives them over OTLP. Every
 * query names the environments it's about, by their IDs, so it can't return another's.
 */
export class PrometheusMetricsStore implements MetricsStore {
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: PrometheusOptions) {
    this.#url = options.url.replace(/\/$/, '');
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async latest(environmentIds: readonly string[]): Promise<ReadonlyMap<string, MetricValues>> {
    if (environmentIds.length === 0) {
      return new Map();
    }
    const selector = `${ENVIRONMENT_LABEL}=~"${environmentIds.map(checkedId).join('|')}"`;
    const window = `${MIN_RATE_WINDOW_SECONDS}s`;
    const answers = await Promise.all(
      METRIC_KEYS.map((key) => this.#ask('/api/v1/query', { query: QUERIES[key](selector, window) })),
    );
    const latest = new Map<string, Record<MetricKey, number | null>>();
    METRIC_KEYS.forEach((key, index) => {
      for (const result of answers[index]!.data?.result ?? []) {
        const id = result.metric?.[ENVIRONMENT_LABEL];
        const value = numberOf(result.value?.[1]);
        if (id === undefined || value === null || !environmentIds.includes(id)) {
          continue;
        }
        const values = latest.get(id) ?? { cpu: null, memory: null, requests: null, responseTime: null, errors: null };
        values[key] = value;
        latest.set(id, values);
      }
    });
    return latest;
  }

  async series(environmentId: string, window: MetricsWindow): Promise<Readonly<Record<MetricKey, readonly Point[]>>> {
    const selector = `${ENVIRONMENT_LABEL}="${checkedId(environmentId)}"`;
    const rateWindow = `${Math.max(MIN_RATE_WINDOW_SECONDS, window.stepSeconds)}s`;
    const answers = await Promise.all(
      METRIC_KEYS.map((key) =>
        this.#ask('/api/v1/query_range', {
          query: QUERIES[key](selector, rateWindow),
          start: String(window.start.getTime() / 1000),
          end: String(window.end.getTime() / 1000),
          step: String(window.stepSeconds),
        }),
      ),
    );
    return Object.fromEntries(
      METRIC_KEYS.map((key, index) => {
        // Each query sums by environment, so it answers with one series at most.
        const values = answers[index]!.data?.result?.find((result) => result.metric?.[ENVIRONMENT_LABEL] === environmentId)?.values ?? [];
        const points = values.flatMap(([at, text]) => {
          const value = numberOf(text);
          return value === null ? [] : [{ at: new Date(at * 1000), value }];
        });
        return [key, points];
      }),
    ) as Record<MetricKey, Point[]>;
  }

  async #ask(path: string, parameters: Record<string, string>): Promise<PrometheusAnswer> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(parameters).toString(),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new MetricsUnavailableError('The metrics store can’t be reached right now. Try again shortly.');
    }
    const answer = (await response.json().catch(() => ({}))) as PrometheusAnswer;
    if (!response.ok || answer.status !== 'success') {
      throw new MetricsUnavailableError(`The metrics store couldn’t answer (HTTP ${response.status}). Try again shortly.`);
    }
    return answer;
  }
}

/** IDs go into queries, so only UUIDs are allowed, which hold nothing PromQL would read as syntax. */
function checkedId(id: string): string {
  if (!isUuid(id)) {
    throw new Error(`"${id}" isn't an environment ID.`);
  }
  return id;
}

/** A sample's value, or null for one that isn't a number, such as a percentile of no requests. */
function numberOf(text: string | undefined): number | null {
  if (text === undefined) {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
