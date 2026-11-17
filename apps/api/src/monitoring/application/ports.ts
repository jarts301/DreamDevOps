import type { MetricKey, MetricValues } from '../domain/metrics.ts';
import type { StoredTrace } from '../domain/traces.ts';

/** Provides the MetricsStore, or null when this server keeps no metrics. */
export const METRICS_STORE = Symbol('METRICS_STORE');

export interface Point {
  readonly at: Date;
  readonly value: number;
}

/** One metric over a window, and its highest value in the day before it. */
export interface SeriesData {
  /** One point per step, with gaps where the application sent nothing. */
  readonly points: readonly Point[];
  /** The highest value in the 24 hours before the window, or null when it sent nothing then. */
  readonly dailyHigh: number | null;
}

export interface MetricsWindow {
  readonly start: Date;
  readonly end: Date;
  readonly stepSeconds: number;
}

/**
 * Where applications' metrics are kept. Places, each one application in one environment,
 * are named by their IDs, which every metric carries, so a store never answers for places
 * it wasn't asked about.
 */
export interface MetricsStore {
  /** Each place's latest values, for those that sent any recently. */
  latest(placeIds: readonly string[]): Promise<ReadonlyMap<string, MetricValues>>;
  /**
   * One place's metrics over a window, one point per step, with gaps where it sent
   * nothing, and each one's highest value in the day before the window, worked out the
   * same way, so the two compare.
   */
  series(placeId: string, window: MetricsWindow): Promise<Readonly<Record<MetricKey, SeriesData>>>;
}

/** The store can't be reached, or answered with something it shouldn't. The message is safe to show. */
export class MetricsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricsUnavailableError';
  }
}

/** Provides the TraceStore, or null when this server keeps no traces. */
export const TRACE_STORE = Symbol('TRACE_STORE');

/**
 * Where applications' traces are kept. Traces can cross environments and companies, so
 * each span says which place sent it, and the caller shows only its own.
 */
export interface TraceStore {
  /** Traces with spans from a service in a window, newest first, at most `limit`. */
  recent(serviceName: string, window: { readonly start: Date; readonly end: Date }, limit: number): Promise<StoredTrace[]>;
  /** One trace, with every span, or null if the store has no such trace. */
  find(traceId: string): Promise<StoredTrace | null>;
}

/** The trace store can't be reached, or answered with something it shouldn't. The message is safe to show. */
export class TracesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TracesUnavailableError';
  }
}

/** One line an application wrote, with when it was written. */
export interface LogEntry {
  readonly at: Date;
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

/** Provides the LogStore, or null when this server keeps no logs. */
export const LOG_STORE = Symbol('LOG_STORE');

/** Where the logs of applications in clusters are kept, by place. */
export interface LogStore {
  /** A place's latest lines since a moment, oldest first, at most `limit`. */
  recent(placeId: string, options: { readonly since: Date; readonly limit: number }): Promise<LogEntry[]>;
}

/** The logs can't be read just now. The message is safe to show. */
export class LogsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogsUnavailableError';
  }
}

/** Provides where the telemetry gateway sends what targets send, or null when it's kept nowhere. */
export const TELEMETRY_SINK = Symbol('TELEMETRY_SINK');

export type TelemetryKind = 'metrics' | 'traces' | 'logs';

/** Where telemetry goes once the gateway has checked it, such as the platform's OpenTelemetry collector. */
export interface TelemetrySink {
  /** Sends one OTLP request, as JSON. */
  send(kind: TelemetryKind, body: object): Promise<void>;
}
