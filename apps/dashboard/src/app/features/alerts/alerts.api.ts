import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  AlertsOverview,
  AlertTestResult,
  AlertView,
  CreateAlert,
  IncidentView,
  Recipient,
  UpdateAlert,
} from '@dreamdevops/contracts/alerts/http';
import type { MonitoredEnvironment, MonitoringOverview } from '@dreamdevops/contracts/monitoring/http';

// The API's answers are Alerts' HTTP contract, under the names the pages use.
export type { AlertsOverview, AlertState, Comparator, Recipient } from '@dreamdevops/contracts/alerts/http';
export type Alert = AlertView;
export type Incident = IncidentView;
export type NewAlert = CreateAlert;
export type AlertChanges = UpdateAlert;

/** An application running in an environment, which an alert can watch, named as people know it. */
export type WatchableEnvironment = Pick<
  MonitoredEnvironment,
  'placeId' | 'environmentId' | 'applicationId' | 'environmentName' | 'applicationName' | 'production'
>;

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

  test(id: string): Promise<AlertTestResult> {
    return firstValueFrom(this.#http.post<AlertTestResult>(`${BASE}/${encodeURIComponent(id)}/test`, {}));
  }

  /**
   * What runs now, which alerts can watch: each application in each environment, by
   * application, production last. Places are named as Monitoring names them.
   */
  async environments(): Promise<WatchableEnvironment[]> {
    const { environments } = await firstValueFrom(this.#http.get<MonitoringOverview>('/api/v1/company/monitoring/places'));
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
