import { trace } from '@opentelemetry/api';

/**
 * What each log line says about the trace it was written in, with OpenTelemetry's names for it.
 * @typedef {{ trace_id?: string, span_id?: string, trace_flags?: string }} TraceFields
 */

/**
 * The trace and span a log line was written in, so tools can show the line beside its
 * trace. Nothing when there's no trace, such as when telemetry is off.
 * @param {import('@opentelemetry/api').Span | undefined} span
 * @returns {TraceFields}
 */
export function traceFieldsOf(span) {
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

/**
 * Adds the current trace to every line the service logs.
 * @returns {TraceFields}
 */
export function currentTraceFields() {
  return traceFieldsOf(trace.getActiveSpan());
}
