import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { MetricDefinition, MetricKey } from '../monitoring/monitoring.api';

export type Comparator = 'above' | 'below';

/** A member of the company an alert can email. */
export interface Recipient {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
}
export type AlertState = 'ok' | 'pending' | 'firing';

export interface Alert {
  readonly id: string;
  readonly name: string;
  /** What it watches: one application in one environment. */
  readonly placeId: string;
  readonly environmentId: string;
  /** Null if the company no longer has the environment. */
  readonly environmentName: string | null;
  readonly applicationId: string;
  readonly applicationName: string | null;
  readonly production: boolean;
  readonly metric: MetricKey;
  readonly comparator: Comparator;
  /** In the metric's own unit: percent, bytes, requests each second, or seconds. */
  readonly threshold: number;
  readonly forMinutes: number;
  /** The condition in words, such as "CPU above 80% for 5 minutes". */
  readonly condition: string;
  /**
   * The members it emails, or null for those who can't manage alerts. Anyone removed from
   * the company is left out, and never emailed.
   */
  readonly recipients: readonly Recipient[] | null;
  readonly recipientCount: number;
  readonly enabled: boolean;
  readonly state: AlertState;
  readonly pendingSince: string | null;
  readonly firingSince: string | null;
  readonly lastValue: number | null;
  readonly lastCheckedAt: string | null;
  readonly checkProblem: string | null;
  readonly lastNotifiedAt: string | null;
  readonly lastNotificationError: string | null;
  readonly createdAt: string;
}

export interface AlertsOverview {
  /** Whether the server keeps metrics. Without them, alerts can't check anything. */
  readonly metricsEnabled: boolean;
  readonly metrics: readonly MetricDefinition[];
  readonly alerts: readonly Alert[];
}

export interface Incident {
  readonly id: string;
  readonly alertId: string;
  readonly alertName: string;
  readonly environmentName: string | null;
  readonly applicationName: string | null;
  readonly production: boolean;
  readonly condition: string;
  readonly startedAt: string;
  readonly startValue: string;
  /** Null while it still fires. */
  readonly resolvedAt: string | null;
  readonly endValue: string | null;
  readonly endedBy: 'recovered' | 'turned-off' | null;
}

export interface NewAlert {
  readonly name: string;
  readonly environmentId: string;
  readonly applicationId: string;
  readonly metric: MetricKey;
  readonly comparator: Comparator;
  readonly threshold: number;
  readonly forMinutes: number;
  /** The user IDs of the members to email. */
  readonly recipients: readonly string[];
}

export interface AlertChanges {
  readonly name?: string;
  readonly threshold?: number;
  readonly forMinutes?: number;
  /** The user IDs of the members to email. */
  readonly recipients?: readonly string[];
  readonly enabled?: boolean;
}

/** An application running in an environment, which an alert can watch, named as people know it. */
export interface WatchableEnvironment {
  /** The place: this application in this environment. */
  readonly placeId: string;
  readonly environmentId: string;
  readonly applicationId: string;
  readonly environmentName: string;
  readonly applicationName: string;
  readonly production: boolean;
}

const BASE = '/api/v1/company/alerts';

@Injectable({ providedIn: 'root' })
export class AlertsApi {
  readonly #http = inject(HttpClient);

  overview(): Promise<AlertsOverview> {
    return firstValueFrom(this.#http.get<AlertsOverview>(BASE));
  }

  /** Whom alerts can email: the company's members. Only for those who manage alerts. */
  members(): Promise<Recipient[]> {
    return firstValueFrom(this.#http.get<Recipient[]>(`${BASE}/members`));
  }

  incidents(): Promise<Incident[]> {
    return firstValueFrom(this.#http.get<Incident[]>(`${BASE}/incidents`));
  }

  create(alert: NewAlert): Promise<Alert> {
    return firstValueFrom(this.#http.post<Alert>(BASE, alert));
  }

  update(id: string, changes: AlertChanges): Promise<Alert> {
    return firstValueFrom(this.#http.patch<Alert>(`${BASE}/${encodeURIComponent(id)}`, changes));
  }

  remove(id: string): Promise<void> {
    return firstValueFrom(this.#http.delete<void>(`${BASE}/${encodeURIComponent(id)}`));
  }

  test(id: string): Promise<{ delivered: boolean; sent: number; error: string | null }> {
    return firstValueFrom(
      this.#http.post<{ delivered: boolean; sent: number; error: string | null }>(`${BASE}/${encodeURIComponent(id)}/test`, {}),
    );
  }

  /**
   * What runs now, which alerts can watch: each application in each environment, by
   * application, production last. Places are named as Monitoring names them.
   */
  async environments(): Promise<WatchableEnvironment[]> {
    const { environments } = await firstValueFrom(
      this.#http.get<{ environments: readonly (WatchableEnvironment & { applicationName: string })[] }>(
        '/api/v1/company/monitoring/places',
      ),
    );
    return environments
      .map(({ placeId, environmentId, applicationId, environmentName, applicationName, production }) => ({
        placeId,
        environmentId,
        applicationId,
        environmentName,
        applicationName,
        production,
      }))
      .sort(
        (left, right) =>
          left.applicationName.localeCompare(right.applicationName) ||
          Number(left.production) - Number(right.production) ||
          left.environmentName.localeCompare(right.environmentName),
      );
  }
}
