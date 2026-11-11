import { MonitoringError } from './errors.ts';

/** One operation in a trace, such as a request a service answered, as the trace store keeps it. */
export interface StoredSpan {
  readonly spanId: string;
  /** The span it happened within, or null for the first of a trace. */
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly serviceName: string;
  /** The environment that sent it, from its attributes, or null when it didn't say. */
  readonly environmentId: string | null;
  readonly start: Date;
  readonly durationMs: number;
  /** Such as server or client. */
  readonly kind: string | null;
  readonly error: boolean;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface StoredTrace {
  readonly traceId: string;
  readonly spans: readonly StoredSpan[];
}

/** A trace, as a list shows it. */
export interface TraceSummary {
  readonly traceId: string;
  /** The name of its first span, such as GET. */
  readonly name: string;
  readonly start: string;
  readonly durationMs: number;
  readonly spans: number;
  readonly errors: number;
  readonly services: readonly string[];
}

/** The most traces a list shows. */
export const MAX_TRACES = 20;

const TRACE_ID = /^[0-9a-f]{32}$/;

/** A W3C trace ID: 32 hexadecimal digits. */
export function parseTraceId(value: unknown): string {
  const id = typeof value === 'string' ? value.toLowerCase() : '';
  if (!TRACE_ID.test(id) || /^0+$/.test(id)) {
    throw new MonitoringError('invalid', 'A trace ID is 32 hexadecimal digits.');
  }
  return id;
}

/** Sums up a trace's spans: its first span's name, when it started, how long it took and what failed. */
export function summarize(traceId: string, spans: readonly StoredSpan[]): TraceSummary {
  const start = Math.min(...spans.map((span) => span.start.getTime()));
  const end = Math.max(...spans.map((span) => span.start.getTime() + span.durationMs));
  const ids = new Set(spans.map((span) => span.spanId));
  const roots = spans.filter((span) => span.parentSpanId === null || !ids.has(span.parentSpanId));
  const first = [...(roots.length > 0 ? roots : spans)].sort((left, right) => left.start.getTime() - right.start.getTime())[0]!;
  return {
    traceId,
    name: first.name,
    start: new Date(start).toISOString(),
    durationMs: end - start,
    spans: spans.length,
    errors: spans.filter((span) => span.error).length,
    services: [...new Set(spans.map((span) => span.serviceName))].sort(),
  };
}
