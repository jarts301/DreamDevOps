/** Levels as most logging libraries name them. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** One line an application wrote, read for people. */
export interface LogLine {
  readonly at: string;
  readonly stream: 'stdout' | 'stderr';
  /** Its level, when it says, or null. */
  readonly level: LogLevel | null;
  readonly message: string;
  /** The trace it was written in, when it says, so people can open that trace. */
  readonly traceId: string | null;
  readonly spanId: string | null;
}

/** The most lines shown at once. */
export const MAX_LOG_LINES = 500;

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
/** W3C Trace Context: version, trace ID, parent span ID and flags. */
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
/** pino's numeric levels, which Fastify writes. */
const NUMERIC_LEVELS: readonly [number, LogLevel][] = [
  [10, 'trace'],
  [20, 'debug'],
  [30, 'info'],
  [40, 'warn'],
  [50, 'error'],
];
const NAMED_LEVELS: Readonly<Record<string, LogLevel>> = {
  trace: 'trace',
  debug: 'debug',
  info: 'info',
  information: 'info',
  notice: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  err: 'error',
  fatal: 'fatal',
  critical: 'fatal',
  crit: 'fatal',
};

/**
 * Reads a line. Lines in JSON, such as pino's, which Fastify writes, or nginx's in the
 * blueprint, give their level, message and trace. Any other line is shown as it is.
 */
export function parseLogLine(entry: { readonly at: Date; readonly stream: 'stdout' | 'stderr'; readonly text: string }): LogLine {
  const plain: LogLine = {
    at: entry.at.toISOString(),
    stream: entry.stream,
    level: null,
    message: entry.text,
    traceId: null,
    spanId: null,
  };
  const fields = jsonObject(entry.text);
  if (fields === null) {
    return plain;
  }
  const traceparent = TRACEPARENT.exec(text(fields['traceparent']) ?? '');
  const traceId = idOf(fields['trace_id'] ?? fields['traceId'] ?? traceparent?.[1], TRACE_ID);
  return {
    ...plain,
    level: levelOf(fields['level'] ?? fields['severity']),
    message: messageOf(fields) ?? entry.text,
    traceId,
    spanId: traceId === null ? null : idOf(fields['span_id'] ?? fields['spanId'] ?? traceparent?.[2], SPAN_ID),
  };
}

function jsonObject(line: string): Record<string, unknown> | null {
  if (!line.startsWith('{')) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function levelOf(value: unknown): LogLevel | null {
  if (typeof value === 'number') {
    return NUMERIC_LEVELS.find(([limit]) => value <= limit)?.[1] ?? 'fatal';
  }
  return typeof value === 'string' ? (NAMED_LEVELS[value.toLowerCase()] ?? null) : null;
}

/** The message, with the request a web framework logged it about, such as "request completed: GET /api/ping 200 in 3 ms". */
function messageOf(fields: Record<string, unknown>): string | null {
  const message = text(fields['msg']) ?? text(fields['message']);
  if (message === null) {
    return null;
  }
  const request = fields['req'] as { method?: unknown; url?: unknown } | undefined;
  const response = fields['res'] as { statusCode?: unknown } | undefined;
  const details = [
    text(request?.method),
    text(request?.url),
    typeof response?.statusCode === 'number' ? String(response.statusCode) : null,
    typeof fields['responseTime'] === 'number' ? `in ${Math.round(fields['responseTime'])} ms` : null,
  ].filter((part) => part !== null);
  return details.length === 0 ? message : `${message}: ${details.join(' ')}`;
}

function idOf(value: unknown, pattern: RegExp): string | null {
  const id = text(value)?.toLowerCase() ?? null;
  return id !== null && pattern.test(id) && !/^0+$/.test(id) ? id : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
