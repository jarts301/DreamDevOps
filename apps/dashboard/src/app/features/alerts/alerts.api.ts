import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CatalogApi } from '../catalog/catalog.api';
import { EnvironmentsApi } from '../environments/environments.api';
import type { MetricDefinition, MetricKey } from '../monitoring/monitoring.api';

export type Comparator = 'above' | 'below';
export type AlertState = 'ok' | 'pending' | 'firing';

export interface Alert {
  readonly id: string;
  readonly name: string;
  readonly environmentId: string;
  /** Null if the company no longer has the environment. */
  readonly environmentName: string | null;
  readonly applicationId: string | null;
  readonly applicationName: string | null;
  readonly production: boolean;
  readonly metric: MetricKey;
  readonly comparator: Comparator;
  /** In the metric's own unit: percent, bytes, requests each second, or seconds. */
  readonly threshold: number;
  readonly forMinutes: number;
  /** The condition in words, such as "CPU above 80% for 5 minutes". */
  readonly condition: string;
  /** The addresses it emails, or null for members who can't manage alerts. */
  readonly recipients: readonly string[] | null;
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
  readonly metric: MetricKey;
  readonly comparator: Comparator;
  readonly threshold: number;
  readonly forMinutes: number;
  readonly recipients: readonly string[];
}

export interface AlertChanges {
  readonly name?: string;
  readonly threshold?: number;
  readonly forMinutes?: number;
  readonly recipients?: readonly string[];
  readonly enabled?: boolean;
}

/** An environment an alert can watch, named as people know it. */
export interface WatchableEnvironment {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly applicationName: string;
  readonly production: boolean;
}

const BASE = '/api/v1/company/alerts';

@Injectable({ providedIn: 'root' })
export class AlertsApi {
  readonly #http = inject(HttpClient);
  readonly #catalog = inject(CatalogApi);
  readonly #environments = inject(EnvironmentsApi);

  overview(): Promise<AlertsOverview> {
    return firstValueFrom(this.#http.get<AlertsOverview>(BASE));
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

  /** Every active environment of every active application, by application, production last. */
  async environments(): Promise<WatchableEnvironment[]> {
    const applications = await this.#catalog.list('active');
    const lists = await Promise.all(
      applications.map(async (application) =>
        (await this.#environments.environments(application.id, 'active')).map((environment) => ({
          environmentId: environment.id,
          environmentName: environment.name,
          applicationName: application.name,
          production: environment.production,
        })),
      ),
    );
    return lists.flatMap((list) =>
      [...list].sort(
        (left, right) => Number(left.production) - Number(right.production) || left.environmentName.localeCompare(right.environmentName),
      ),
    );
  }
}
