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
}

export interface EnvironmentMetrics {
  readonly environment: MonitoredEnvironment;
  readonly range: { readonly key: TimeRangeKey; readonly start: string; readonly end: string; readonly stepSeconds: number };
  readonly series: readonly MetricSeries[];
}

@Injectable({ providedIn: 'root' })
export class MonitoringApi {
  readonly #http = inject(HttpClient);

  overview(): Promise<MonitoringOverview> {
    return firstValueFrom(this.#http.get<MonitoringOverview>('/api/v1/company/monitoring/environments'));
  }

  environment(environmentId: string, range: TimeRangeKey): Promise<EnvironmentMetrics> {
    return firstValueFrom(
      this.#http.get<EnvironmentMetrics>(`/api/v1/company/monitoring/environments/${encodeURIComponent(environmentId)}`, {
        params: { range },
      }),
    );
  }
}
