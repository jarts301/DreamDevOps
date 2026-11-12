import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type MetricKey = 'cpu' | 'memory' | 'requests' | 'responseTime' | 'errors';
export type MetricUnit = 'percent' | 'bytes' | 'per-second' | 'seconds';
export type TimeRangeKey = '15m' | '1h' | '6h' | '24h';

export interface MetricDefinition {
  readonly key: MetricKey;
  readonly name: string;
  readonly unit: MetricUnit;
  readonly description: string;
}

/** Each metric's latest value, or null where the application sent nothing to work it out from. */
export type MetricValues = Readonly<Record<MetricKey, number | null>>;

/** What a container may use at most. */
export interface ContainerLimits {
  readonly cpus: number;
  readonly memoryBytes: number;
}

export interface MonitoredEnvironment {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly applicationId: string;
  readonly applicationName: string;
  readonly production: boolean;
  readonly version: string | null;
  readonly since: string | null;
  readonly address: string | null;
  readonly targetName: string | null;
  /** What its container may use at most, or null when unknown. */
  readonly limits: ContainerLimits | null;
}

export interface MonitoringOverview {
  /** Whether the server keeps applications' metrics at all. */
  readonly enabled: boolean;
  /** Why the metrics couldn't be read just now, if they couldn't. */
  readonly problem: string | null;
  readonly metrics: readonly MetricDefinition[];
  readonly environments: readonly (MonitoredEnvironment & { readonly latest: MetricValues })[];
}

export interface MetricSeries extends MetricDefinition {
  /** Oldest first. Steps where the application sent nothing have no point. */
  readonly points: readonly { readonly at: string; readonly value: number }[];
  /** The highest value in the day before the range, what's been normal lately, or null when it sent nothing then. */
  readonly dailyHigh: number | null;
}

export interface EnvironmentMetrics {
  readonly environment: MonitoredEnvironment;
  readonly range: { readonly key: TimeRangeKey; readonly start: string; readonly end: string; readonly stepSeconds: number };
  /** The day each series' daily high comes from: the 24 hours before the range. */
  readonly dailyHigh: { readonly start: string; readonly end: string };
  readonly series: readonly MetricSeries[];
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** One line an application wrote. */
export interface LogLine {
  readonly at: string;
  readonly stream: 'stdout' | 'stderr';
  /** Its level, when it says, or null. */
  readonly level: LogLevel | null;
  readonly message: string;
  /** The trace it was written in, when it says. */
  readonly traceId: string | null;
  readonly spanId: string | null;
}

export interface EnvironmentLogs {
  readonly environmentId: string;
  /** Whether a version runs in it. When none does, there's nothing to read. */
  readonly running: boolean;
  readonly range: { readonly key: TimeRangeKey; readonly start: string; readonly end: string };
  /** Oldest first. */
  readonly lines: readonly LogLine[];
}

export interface TraceSummary {
  readonly traceId: string;
  readonly name: string;
  readonly start: string;
  readonly durationMs: number;
  readonly spans: number;
  readonly errors: number;
  readonly services: readonly string[];
}

export interface EnvironmentTraces {
  /** Whether the server keeps traces at all. */
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly range: { readonly key: TimeRangeKey; readonly start: string; readonly end: string };
  /** Newest first. */
  readonly traces: readonly TraceSummary[];
}

export interface Span {
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

export interface Trace {
  readonly traceId: string;
  readonly start: string;
  readonly durationMs: number;
  /** The company's own spans, in the order they started. */
  readonly spans: readonly Span[];
  /** Spans from elsewhere, which aren't shown. */
  readonly hiddenSpans: number;
}

@Injectable({ providedIn: 'root' })
export class MonitoringApi {
  readonly #http = inject(HttpClient);

  overview(): Promise<MonitoringOverview> {
    return firstValueFrom(this.#http.get<MonitoringOverview>('/api/v1/company/monitoring/environments'));
  }

  logs(environmentId: string, range: TimeRangeKey): Promise<EnvironmentLogs> {
    return firstValueFrom(
      this.#http.get<EnvironmentLogs>(`/api/v1/company/monitoring/environments/${encodeURIComponent(environmentId)}/logs`, {
        params: { range },
      }),
    );
  }

  traces(environmentId: string, range: TimeRangeKey): Promise<EnvironmentTraces> {
    return firstValueFrom(
      this.#http.get<EnvironmentTraces>(`/api/v1/company/monitoring/environments/${encodeURIComponent(environmentId)}/traces`, {
        params: { range },
      }),
    );
  }

  trace(traceId: string): Promise<Trace> {
    return firstValueFrom(this.#http.get<Trace>(`/api/v1/company/monitoring/traces/${encodeURIComponent(traceId)}`));
  }

  environment(environmentId: string, range: TimeRangeKey): Promise<EnvironmentMetrics> {
    return firstValueFrom(
      this.#http.get<EnvironmentMetrics>(`/api/v1/company/monitoring/environments/${encodeURIComponent(environmentId)}`, {
        params: { range },
      }),
    );
  }
}
