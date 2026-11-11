import { ENVIRONMENT_ATTRIBUTE } from '../../environments/domain/telemetry.ts';
import type { StoredSpan, StoredTrace } from '../domain/traces.ts';
import { type TraceStore, TracesUnavailableError } from '../application/ports.ts';

export interface JaegerOptions {
  /** Where Jaeger's query API and page are, such as http://localhost:16686. */
  readonly url: string;
  readonly timeoutMs?: number;
  /** Makes HTTP requests. Tests pass their own. */
  readonly fetch?: typeof fetch;
}

interface JaegerTag {
  key: string;
  type?: string;
  value: unknown;
}

interface JaegerSpan {
  traceID: string;
  spanID: string;
  operationName?: string;
  references?: { refType?: string; traceID?: string; spanID?: string }[] | null;
  /** Microseconds since 1970. */
  startTime: number;
  /** Microseconds. */
  duration: number;
  tags?: JaegerTag[] | null;
  processID: string;
}

interface JaegerTrace {
  traceID: string;
  spans?: JaegerSpan[] | null;
  processes?: Record<string, { serviceName?: string; tags?: JaegerTag[] | null }> | null;
}

/** The most attributes kept from a span, and the longest value, so one span can't flood the page. */
const MAX_ATTRIBUTES = 30;
const MAX_VALUE_LENGTH = 300;
/** Tags Jaeger adds for what the store itself shows in other ways. */
const LEFT_OUT = new Set(['span.kind', 'error', 'otel.status_code', 'internal.span.format']);

/**
 * Reads traces from Jaeger's query API, which serves its own page too. Applications send
 * their traces to Jaeger over OTLP, and their resource attributes, such as the
 * environment's ID, become each span's process tags.
 */
export class JaegerTraceStore implements TraceStore {
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: JaegerOptions) {
    this.#url = options.url.replace(/\/$/, '');
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async recent(serviceName: string, window: { readonly start: Date; readonly end: Date }, limit: number): Promise<StoredTrace[]> {
    const query = new URLSearchParams({
      service: serviceName,
      start: String(window.start.getTime() * 1000),
      end: String(window.end.getTime() * 1000),
      limit: String(limit),
    });
    const answer = await this.#ask(`/api/traces?${query}`);
    return (answer?.data ?? [])
      .map(toTrace)
      .sort((left, right) => Math.max(...right.spans.map(started)) - Math.max(...left.spans.map(started)));
  }

  async find(traceId: string): Promise<StoredTrace | null> {
    if (!/^[0-9a-f]{32}$/.test(traceId)) {
      return null;
    }
    const answer = await this.#ask(`/api/traces/${traceId}`);
    const trace = answer?.data?.[0];
    return trace === undefined ? null : toTrace(trace);
  }

  /** Jaeger's answer, or null when it has nothing there. */
  async #ask(path: string): Promise<{ data?: JaegerTrace[] | null } | null> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#url}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new TracesUnavailableError('The trace store can’t be reached right now. Try again shortly.');
    }
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new TracesUnavailableError(`The trace store couldn’t answer (HTTP ${response.status}). Try again shortly.`);
    }
    try {
      return (await response.json()) as { data?: JaegerTrace[] | null };
    } catch {
      throw new TracesUnavailableError('The trace store answered with something that isn’t a trace.');
    }
  }
}

function toTrace(trace: JaegerTrace): StoredTrace {
  const traceId = normalizeId(trace.traceID, 32);
  return {
    traceId,
    spans: (trace.spans ?? []).map((span) => {
      const process = trace.processes?.[span.processID];
      const tags = span.tags ?? [];
      const tag = (key: string) => tags.find((candidate) => candidate.key === key)?.value;
      const parent = (span.references ?? []).find((reference) => reference.refType === 'CHILD_OF' && reference.spanID);
      const environment = (process?.tags ?? []).find((candidate) => candidate.key === ENVIRONMENT_ATTRIBUTE)?.value;
      return {
        spanId: normalizeId(span.spanID, 16),
        parentSpanId: parent?.spanID ? normalizeId(parent.spanID, 16) : null,
        name: span.operationName || 'Unnamed',
        serviceName: process?.serviceName ?? 'unknown',
        environmentId: typeof environment === 'string' ? environment.toLowerCase() : null,
        start: new Date(Math.floor(span.startTime / 1000)),
        durationMs: span.duration / 1000,
        kind: typeof tag('span.kind') === 'string' ? (tag('span.kind') as string) : null,
        error: tag('error') === true || tag('error') === 'true' || tag('otel.status_code') === 'ERROR',
        attributes: attributesOf(tags),
      } satisfies StoredSpan;
    }),
  };
}

function attributesOf(tags: readonly JaegerTag[]): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {};
  for (const { key, value } of tags.filter((tag) => !LEFT_OUT.has(tag.key)).slice(0, MAX_ATTRIBUTES)) {
    attributes[key] =
      typeof value === 'number' || typeof value === 'boolean' ? value : String(value).slice(0, MAX_VALUE_LENGTH);
  }
  return attributes;
}

/** Jaeger leaves out leading zeros in IDs, which W3C IDs keep. */
function normalizeId(id: string, length: number): string {
  return id.toLowerCase().padStart(length, '0');
}

function started(span: StoredSpan): number {
  return span.start.getTime();
}
