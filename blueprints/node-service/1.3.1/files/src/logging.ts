import { type Span, trace } from '@opentelemetry/api';

/** What each log line says about the trace it was written in, with OpenTelemetry's names for it. */
export interface TraceFields {
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly trace_flags?: string;
}

/**
 * The trace and span a log line was written in, so tools can show the line beside its
 * trace. Nothing when there's no trace, such as when telemetry is off.
 */
export function traceFieldsOf(span: Span | undefined): TraceFields {
  const context = span?.spanContext();
  if (context === undefined || !trace.isSpanContextValid(context)) {
    return {};
  }
  return {
    trace_id: context.traceId,
    span_id: context.spanId,
    trace_flags: `0${context.traceFlags.toString(16)}`.slice(-2),
  };
}

/** Adds the current trace to every line the service logs. */
export function currentTraceFields(): TraceFields {
  return traceFieldsOf(trace.getActiveSpan());
}
