import { trace, TraceFlags } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { currentTraceFields, traceFieldsOf } from '../src/logging.js';

describe('log lines', () => {
  it('say which trace and span they were written in', () => {
    const span = trace.wrapSpanContext({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: TraceFlags.SAMPLED,
    });

    expect(traceFieldsOf(span)).toEqual({
      trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
      span_id: '00f067aa0ba902b7',
      trace_flags: '01',
    });
  });

  it('say nothing about traces when there is none', () => {
    expect(traceFieldsOf(undefined)).toEqual({});
    expect(traceFieldsOf(trace.wrapSpanContext({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 }))).toEqual({});
    expect(currentTraceFields()).toEqual({});
  });
});
