import type { MetricDefinition, MetricKey } from '../monitoring/metrics.ts';

/** Alerts' HTTP API, as the dashboard sees it. Types only, so a browser app can use them. */

/** Whether an alert fires when the metric goes above its threshold, or below it. */
export type Comparator = 'above' | 'below';

/**
 * An alert is ok, pending while its metric is past the threshold but not yet for long
 * enough, or firing.
 */
export type AlertState = 'ok' | 'pending' | 'firing';

/** A member an alert emails. */
export interface Recipient {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
}

/** An alert, as the dashboard shows it. */
export interface AlertView {
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
   * The members it emails, or null for those who can't manage alerts. Only people who are
   * still members count: anyone removed from the company is left out, and never emailed.
   */
  readonly recipients: readonly Recipient[] | null;
  readonly recipientCount: number;
  readonly enabled: boolean;
  readonly state: AlertState;
  readonly pendingSince: string | null;
  /** When it started firing, while it fires. */
  readonly firingSince: string | null;
  /** The metric's value at the last check, or null when there was none. */
  readonly lastValue: number | null;
  readonly lastCheckedAt: string | null;
  /** Why the last check couldn't read the metric, if it couldn't. */
  readonly checkProblem: string | null;
  readonly lastNotifiedAt: string | null;
  readonly lastNotificationError: string | null;
  readonly createdAt: string;
}

export interface AlertsOverview {
  /** Whether this server keeps metrics. Without them, alerts can't check anything. */
  readonly metricsEnabled: boolean;
  readonly metrics: readonly MetricDefinition[];
  readonly alerts: readonly AlertView[];
}

/** One time an alert fired. */
export interface IncidentView {
  readonly id: string;
  readonly alertId: string;
  readonly alertName: string;
  readonly environmentName: string | null;
  readonly applicationName: string | null;
  readonly production: boolean;
  readonly condition: string;
  readonly startedAt: string;
  /** The value that made it fire, in words. */
  readonly startValue: string;
  /** Null while it still fires. */
  readonly resolvedAt: string | null;
  readonly endValue: string | null;
  readonly endedBy: 'recovered' | 'turned-off' | null;
}

/** Creates an alert on one application in one environment. */
export interface CreateAlert {
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

/** Changes an alert. What it watches stays: fields left out stay as they are. */
export interface UpdateAlert {
  readonly name?: string;
  readonly threshold?: number;
  readonly forMinutes?: number;
  /** The user IDs of the members to email. */
  readonly recipients?: readonly string[];
  readonly enabled?: boolean;
}

/** How a test email went. */
export interface AlertTestResult {
  readonly delivered: boolean;
  readonly sent: number;
  readonly error: string | null;
}
