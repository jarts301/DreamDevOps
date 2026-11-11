import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import type { RunningEnvironment, RunningEnvironments } from '../../environments/application/running-environments.ts';
import { MonitoringError } from '../domain/errors.ts';
import { parseRange, type TimeRangeKey } from '../domain/metrics.ts';
import { MAX_TRACES, parseTraceId, summarize, type TraceSummary } from '../domain/traces.ts';
import { type TraceStore, TracesUnavailableError } from './ports.ts';

const NOT_SET_UP = 'This server doesn’t keep applications’ traces. An administrator can set it up with JAEGER_URL.';

/** Traces that only some spans of belong to the environment take more room in the store's answer. */
const SEARCH_MARGIN = 5;

export interface EnvironmentTraces {
  /** Whether this server keeps traces at all. */
  readonly enabled: boolean;
  /** The service name its traces are found by: the application's short name, unless it sends another. */
  readonly serviceName: string;
  readonly range: { readonly key: TimeRangeKey; readonly start: string; readonly end: string };
  /** Newest first, MAX_TRACES at most, each summed up from this environment's spans. */
  readonly traces: readonly TraceSummary[];
}

export interface SpanView {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly serviceName: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly applicationName: string;
  readonly production: boolean;
  readonly start: string;
  /** Milliseconds from the start of the trace. */
  readonly offsetMs: number;
  readonly durationMs: number;
  readonly kind: string | null;
  readonly error: boolean;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface TraceView {
  readonly traceId: string;
  readonly start: string;
  readonly durationMs: number;
  /** The company's own spans, in the order they started. */
  readonly spans: readonly SpanView[];
  /** Spans from elsewhere, such as another company's service this trace passed through, which aren't shown. */
  readonly hiddenSpans: number;
}

/**
 * The traces of what runs in the company's environments: each request as it passes through
 * one application, and on to the others it calls. A trace can pass through anything, so
 * only the spans the company's own environments sent are ever shown.
 */
export class ApplicationTraces {
  readonly #environments: RunningEnvironments;
  readonly #catalog: ApplicationCatalog;
  readonly #store: TraceStore | null;
  readonly #now: () => Date;

  constructor(
    environments: RunningEnvironments,
    catalog: ApplicationCatalog,
    store: TraceStore | null,
    now: () => Date = () => new Date(),
  ) {
    this.#environments = environments;
    this.#catalog = catalog;
    this.#store = store;
    this.#now = now;
  }

  /** The latest traces an environment took part in, within a range, such as the last hour. */
  async recent(idValue: unknown, rangeValue: unknown): Promise<EnvironmentTraces> {
    const range = parseRange(rangeValue);
    const environment = await this.#environment(idValue);
    const application = await this.#catalog.get(environment.applicationId);
    const end = this.#now();
    const start = new Date(end.getTime() - range.seconds * 1000);
    const window = { key: range.key, start: start.toISOString(), end: end.toISOString() };
    if (this.#store === null) {
      return { enabled: false, serviceName: application.slug, range: window, traces: [] };
    }
    const found = await this.#ask(() => this.#store!.recent(application.slug, { start, end }, MAX_TRACES * SEARCH_MARGIN));
    // Other companies may have a service of the same name, so a trace counts only by this environment's own spans.
    const traces = found
      .map((trace) => ({ traceId: trace.traceId, spans: trace.spans.filter((span) => span.environmentId === environment.environmentId) }))
      .filter((trace) => trace.spans.length > 0)
      .map((trace) => summarize(trace.traceId, trace.spans))
      .sort((left, right) => right.start.localeCompare(left.start))
      .slice(0, MAX_TRACES);
    return { enabled: true, serviceName: application.slug, range: window, traces };
  }

  /** One trace, with the spans of the company's own environments only. */
  async trace(idValue: unknown): Promise<TraceView> {
    const traceId = parseTraceId(idValue);
    if (this.#store === null) {
      throw new MonitoringError('unavailable', NOT_SET_UP);
    }
    const stored = await this.#ask(() => this.#store!.find(traceId));
    const environmentIds = [...new Set((stored?.spans ?? []).flatMap((span) => (span.environmentId === null ? [] : [span.environmentId])))];
    // Each is looked up in the current company, so another company's environments aren't found.
    const own = new Map<string, { environment: RunningEnvironment; applicationName: string }>();
    for (const environment of await Promise.all(environmentIds.map((id) => this.#environments.find(id)))) {
      if (environment !== null) {
        own.set(environment.environmentId, {
          environment,
          applicationName: (await this.#catalog.get(environment.applicationId)).name,
        });
      }
    }
    const spans = (stored?.spans ?? []).filter((span) => span.environmentId !== null && own.has(span.environmentId));
    if (spans.length === 0) {
      throw new MonitoringError('not-found', 'There’s no such trace, or none of it comes from your applications.');
    }
    const summary = summarize(traceId, spans);
    const start = Date.parse(summary.start);
    return {
      traceId,
      start: summary.start,
      durationMs: summary.durationMs,
      spans: [...spans]
        .sort((left, right) => left.start.getTime() - right.start.getTime())
        .map((span) => {
          const { environment, applicationName } = own.get(span.environmentId!)!;
          return {
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            name: span.name,
            serviceName: span.serviceName,
            environmentId: environment.environmentId,
            environmentName: environment.environmentName,
            applicationName,
            production: environment.production,
            start: span.start.toISOString(),
            offsetMs: span.start.getTime() - start,
            durationMs: span.durationMs,
            kind: span.kind,
            error: span.error,
            attributes: span.attributes,
          };
        }),
      hiddenSpans: stored!.spans.length - spans.length,
    };
  }

  async #environment(idValue: unknown): Promise<RunningEnvironment> {
    const environment = typeof idValue === 'string' ? await this.#environments.find(idValue) : null;
    if (environment === null) {
      throw new MonitoringError('not-found', 'There’s no such environment.');
    }
    return environment;
  }

  async #ask<T>(question: () => Promise<T>): Promise<T> {
    try {
      return await question();
    } catch (error) {
      if (error instanceof TracesUnavailableError) {
        throw new MonitoringError('unavailable', error.message);
      }
      throw error;
    }
  }
}
