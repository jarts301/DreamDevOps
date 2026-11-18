import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  EnvironmentLogView,
  EnvironmentMetrics,
  EnvironmentTraces,
  MonitoringOverview,
  SpanView,
  TimeRangeKey,
  TraceView,
} from '@dreamdevops/contracts/monitoring/http';

// The API's answers are Monitoring's HTTP contract, under the names the pages use.
export type { MetricDefinition, MetricKey, MetricUnit, MetricValues } from '@dreamdevops/contracts/monitoring/metrics';
export type {
  ContainerLimits,
  EnvironmentMetrics,
  EnvironmentTraces,
  LogLevel,
  LogLine,
  MetricSeries,
  MonitoredEnvironment,
  MonitoringOverview,
  TimeRangeKey,
  TraceSummary,
} from '@dreamdevops/contracts/monitoring/http';
export type EnvironmentLogs = EnvironmentLogView;
export type Span = SpanView;
export type Trace = TraceView;

@Injectable({ providedIn: 'root' })
export class MonitoringApi {
  readonly #http = inject(HttpClient);

  overview(): Promise<MonitoringOverview> {
    return firstValueFrom(this.#http.get<MonitoringOverview>('/api/v1/company/monitoring/places'));
  }

  logs(placeId: string, range: TimeRangeKey): Promise<EnvironmentLogs> {
    return firstValueFrom(
      this.#http.get<EnvironmentLogs>(`/api/v1/company/monitoring/places/${encodeURIComponent(placeId)}/logs`, {
        params: { range },
      }),
    );
  }

  traces(placeId: string, range: TimeRangeKey): Promise<EnvironmentTraces> {
    return firstValueFrom(
      this.#http.get<EnvironmentTraces>(`/api/v1/company/monitoring/places/${encodeURIComponent(placeId)}/traces`, {
        params: { range },
      }),
    );
  }

  trace(traceId: string): Promise<Trace> {
    return firstValueFrom(this.#http.get<Trace>(`/api/v1/company/monitoring/traces/${encodeURIComponent(traceId)}`));
  }

  environment(placeId: string, range: TimeRangeKey): Promise<EnvironmentMetrics> {
    return firstValueFrom(
      this.#http.get<EnvironmentMetrics>(`/api/v1/company/monitoring/places/${encodeURIComponent(placeId)}`, {
        params: { range },
      }),
    );
  }
}
