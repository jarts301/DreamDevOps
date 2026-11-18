import type { EnvironmentTraces, TraceView } from '@dreamdevops/contracts/monitoring/http';
import { MonitoringError } from '../domain/errors.ts';
import { parseRange } from '../domain/metrics.ts';
import { MAX_TRACES, parseTraceId, summarize } from '../domain/traces.ts';
import { type TraceStore, TracesUnavailableError } from './ports.ts';
import type { RunningPlace, RunningPlaces } from './running-places.ts';

const NOT_SET_UP = 'This server doesn’t keep applications’ traces. An administrator can set it up with JAEGER_URL.';

/** Traces that only some spans of belong to the environment take more room in the store's answer. */
const SEARCH_MARGIN = 5;

/**
 * The traces of what runs in the company's environments: each request as it passes through
 * one application, and on to the others it calls. A trace can pass through anything, so
 * only the spans the company's own environments sent are ever shown.
 */
export class ApplicationTraces {
  readonly #places: RunningPlaces;
  readonly #store: TraceStore | null;
  readonly #now: () => Date;

  constructor(places: RunningPlaces, store: TraceStore | null, now: () => Date = () => new Date()) {
    this.#places = places;
    this.#store = store;
    this.#now = now;
  }

  /** The latest traces an environment took part in, within a range, such as the last hour. */
  async recent(idValue: unknown, rangeValue: unknown): Promise<EnvironmentTraces> {
    const range = parseRange(rangeValue);
    const environment = await this.#environment(idValue);
    const application = { slug: environment.applicationSlug };
    const end = this.#now();
    const start = new Date(end.getTime() - range.seconds * 1000);
    const window = { key: range.key, start: start.toISOString(), end: end.toISOString() };
    if (this.#store === null) {
      return { enabled: false, serviceName: application.slug, range: window, traces: [] };
    }
    const found = await this.#ask(() => this.#store!.recent(application.slug, { start, end }, MAX_TRACES * SEARCH_MARGIN));
    // Other companies may have a service of the same name, so a trace counts only by this place's own spans.
    const traces = found
      .map((trace) => ({ traceId: trace.traceId, spans: trace.spans.filter((span) => span.placeId === environment.placeId) }))
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
    // Only the current company's places count, so another company's spans aren't shown.
    const own = new Map<string, RunningPlace>((await this.#places.list()).map((place) => [place.placeId, place]));
    const spans = (stored?.spans ?? []).filter((span) => span.placeId !== null && own.has(span.placeId));
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
          const environment = own.get(span.placeId!)!;
          return {
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            name: span.name,
            serviceName: span.serviceName,
            placeId: environment.placeId,
            environmentId: environment.environmentId,
            environmentName: environment.environmentName,
            applicationName: environment.applicationName,
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

  async #environment(idValue: unknown): Promise<RunningPlace> {
    const place = await this.#places.find(idValue);
    if (place === null) {
      throw new MonitoringError('not-found', 'Nothing of yours runs there.');
    }
    return place;
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
