import type { IncidentView } from '@dreamdevops/contracts/alerts/http';
import type { MetricKey } from '@dreamdevops/contracts/monitoring/metrics';
import type { EventLog, Transactional } from '@dreamdevops/shared-kernel';
import type { Comparator } from '../domain/alert.ts';
import type { AlertState } from '../domain/evaluation.ts';

/** What an alert watches, and how it's been, as Alerts keeps it. */
export interface StoredAlert {
  readonly id: string;
  readonly name: string;
  readonly placeId: string;
  readonly environmentId: string;
  readonly applicationId: string;
  readonly metric: MetricKey;
  readonly comparator: Comparator;
  readonly threshold: number;
  readonly forMinutes: number;
  /** The members it emails, by user ID. */
  readonly recipientIds: readonly string[];
  readonly enabled: boolean;
  readonly state: AlertState;
  readonly pendingSince: Date | null;
  readonly lastValue: number | null;
  readonly lastCheckedAt: Date | null;
  readonly checkProblem: string | null;
  readonly lastNotifiedAt: Date | null;
  readonly lastNotificationError: string | null;
  readonly createdAt: Date;
  /** When its open incident started, while it fires. */
  readonly firingSince: Date | null;
}

/** What a check needs of an alert that's on. */
export type WatchedAlert = Pick<
  StoredAlert,
  'id' | 'name' | 'placeId' | 'environmentId' | 'applicationId' | 'metric' | 'comparator' | 'threshold' | 'forMinutes' | 'state' | 'pendingSince'
>;

export interface NewAlert {
  readonly id: string;
  readonly name: string;
  readonly placeId: string;
  readonly environmentId: string;
  readonly applicationId: string;
  readonly metric: MetricKey;
  readonly comparator: Comparator;
  readonly threshold: number;
  readonly forMinutes: number;
  readonly recipientIds: readonly string[];
  readonly createdBy: string;
}

/** One time an alert fired, with what its alert watches. */
export interface StoredIncident {
  readonly id: string;
  readonly alertId: string;
  readonly alertName: string;
  readonly placeId: string;
  readonly environmentId: string;
  readonly applicationId: string;
  readonly metric: MetricKey;
  readonly comparator: Comparator;
  readonly threshold: number;
  readonly forMinutes: number;
  readonly startedAt: Date;
  readonly startValue: number | null;
  readonly resolvedAt: Date | null;
  readonly endValue: number | null;
  readonly endedBy: IncidentView['endedBy'];
}

/** The current company's alerts and their incidents, in one transaction. */
export interface AlertsSession extends EventLog {
  /** Every alert, by name. */
  list(): Promise<StoredAlert[]>;
  find(id: string): Promise<StoredAlert | null>;
  /** One alert, locked until the transaction ends. */
  lock(id: string): Promise<StoredAlert | null>;
  /** What an alert watches, or null when there's no such alert. */
  placeOf(id: string): Promise<{ readonly environmentId: string; readonly applicationId: string } | null>;
  /** Lets one alert at a time take a name in the current company. */
  lockNames(): Promise<void>;
  isNameTaken(name: string, exceptId: string | null): Promise<boolean>;
  add(alert: NewAlert): Promise<void>;
  /** Changes an alert. One turned off is ok again, until it's turned on and checked. */
  update(
    id: string,
    changes: {
      readonly name: string;
      readonly threshold: number;
      readonly forMinutes: number;
      readonly recipientIds: readonly string[];
      readonly enabled: boolean;
      readonly turnedOff: boolean;
    },
  ): Promise<void>;
  delete(id: string): Promise<void>;
  /** Takes a member off every alert. */
  forgetMember(userId: string): Promise<void>;
  /** The latest incidents, newest first. */
  history(limit: number): Promise<StoredIncident[]>;
  /** Records when an alert last emailed, when it did, and why it failed, if it did. */
  recordNotification(id: string, outcome: { readonly notified: boolean; readonly error: string | null }): Promise<void>;
  /** The alerts that are on. */
  watched(): Promise<WatchedAlert[]>;
  /** The alerts that are on, of these places, locked. */
  lockWatched(placeIds: readonly string[]): Promise<WatchedAlert[]>;
  /** Why the metrics of these places couldn't be read, on their alerts that are on. */
  recordCheckProblem(placeIds: readonly string[], problem: string): Promise<void>;
  recordCheck(
    id: string,
    check: { readonly state: AlertState; readonly pendingSince: Date | null; readonly value: number | null; readonly checkedAt: Date },
  ): Promise<void>;
  openIncident(alertId: string, incident: { readonly id: string; readonly startedAt: Date; readonly value: number | null }): Promise<void>;
  /** Ends an alert's open incident, and returns it, or null when it has none. */
  endIncident(
    alertId: string,
    end: { readonly at: Date; readonly value: number | null; readonly endedBy: 'recovered' | 'turned-off' },
  ): Promise<{ readonly id: string; readonly startedAt: Date } | null>;
  /** The companies, of any company, with an alert that's on. */
  companiesWithEnabledAlerts(): Promise<string[]>;
}

export const ALERTS_STORE = Symbol('ALERTS_STORE');

export type AlertsStore = Transactional<AlertsSession>;
