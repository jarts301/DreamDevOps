import type { MetricDefinition, MetricValues } from './metrics.ts';

/** Monitoring's HTTP API, as the dashboard sees it. Types only, so a browser app can use them. */

export type TimeRangeKey = '15m' | '1h' | '6h' | '24h';

/** What a container may use at most. */
export interface ContainerLimits {
  readonly cpus: number;
  readonly memoryBytes: number;
}

/** An application that runs in an environment, its place, as the monitoring page lists it. */
export interface MonitoredEnvironment {
  /** The place: this application in this environment. Routes name it by this. */
  readonly placeId: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly applicationId: string;
  readonly applicationName: string;
  readonly production: boolean;
  readonly version: string | null;
  readonly since: string | null;
  readonly address: string | null;
  /** What runs the environment, such as kubernetes, or local for This machine. */
  readonly provider: string | null;
  /** What its container may use at most, to set its CPU and memory against, or null when unknown. */
  readonly limits: ContainerLimits | null;
}

export interface MonitoringOverview {
  /** Whether this server keeps applications' metrics at all. */
  readonly enabled: boolean;
  /** Why the metrics couldn't be read just now, if they couldn't. The environments are listed anyway. */
  readonly problem: string | null;
  readonly metrics: readonly MetricDefinition[];
  /** Each application that runs in an environment, with its latest metrics. */
  readonly environments: readonly (MonitoredEnvironment & { readonly latest: MetricValues })[];
}

/** The times a range covers. */
export interface RangeView {
  readonly key: TimeRangeKey;
  readonly start: string;
  readonly end: string;
}

export interface MetricSeries extends MetricDefinition {
  /** One point per step, oldest first. Steps where the application sent nothing have no point. */
  readonly points: readonly { readonly at: string; readonly value: number }[];
  /**
   * The highest value in the day before the range, what's been normal lately, or null when
   * the application sent nothing then. Values above it are higher than any that day.
   */
  readonly dailyHigh: number | null;
}

export interface EnvironmentMetrics {
  readonly environment: MonitoredEnvironment;
  readonly range: RangeView & { readonly stepSeconds: number };
  /** The day each series' daily high comes from: the 24 hours before the range. */
  readonly dailyHigh: { readonly start: string; readonly end: string };
  readonly series: readonly MetricSeries[];
}

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

export interface EnvironmentLogView {
  readonly placeId: string;
  /** Whether a version runs there. When none does, there's nothing to read. */
  readonly running: boolean;
  readonly range: RangeView;
  /** Oldest first, the latest lines only. */
  readonly lines: readonly LogLine[];
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

export interface EnvironmentTraces {
  /** Whether this server keeps traces at all. */
  readonly enabled: boolean;
  /** The service name its traces are found by: the application's short name, unless it sends another. */
  readonly serviceName: string;
  readonly range: RangeView;
  /** Newest first, each summed up from this environment's spans. */
  readonly traces: readonly TraceSummary[];
}

export interface SpanView {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly serviceName: string;
  readonly placeId: string;
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
