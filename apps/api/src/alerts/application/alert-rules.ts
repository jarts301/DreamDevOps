import { randomUUID } from 'node:crypto';
import { createDomainEvent, currentCompanyId, describeError, type DomainEvent } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { Principal } from '../../identity-access/domain/access.ts';
import type { LatestMetrics } from '../../monitoring/application/latest-metrics.ts';
import { type MetricDefinition, type MetricKey, METRICS } from '../../monitoring/domain/metrics.ts';
import type { AlertEmails } from '../../notifications/application/alert-emails.ts';
import {
  type AlertCondition,
  type Comparator,
  describeCondition,
  describeValue,
  parseAlertId,
  parseAlertName,
  parseComparator,
  parseEnvironmentId,
  parseForMinutes,
  parseMetric,
  parseRecipients,
  parseThreshold,
} from '../domain/alert.ts';
import { AlertError } from '../domain/errors.ts';
import type { AlertState } from '../domain/evaluation.ts';
import type { AlertCreatedPayload, AlertPayload, AlertUpdatedPayload } from '../domain/events.ts';
import type { Place, Places } from './places.ts';

/** An alert, as the dashboard shows it. */
export interface AlertView {
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

export interface TestResult {
  readonly delivered: boolean;
  readonly sent: number;
  readonly error: string | null;
}

interface AlertRow {
  id: string;
  name: string;
  environment_id: string;
  metric: MetricKey;
  comparator: Comparator;
  threshold: number;
  for_minutes: number;
  recipients: string[];
  enabled: boolean;
  state: AlertState;
  pending_since: Date | null;
  last_value: number | null;
  last_checked_at: Date | null;
  check_problem: string | null;
  last_notified_at: Date | null;
  last_notification_error: string | null;
  created_at: Date;
  firing_since: Date | null;
}

interface IncidentRow {
  id: string;
  alert_id: string;
  alert_name: string;
  environment_id: string;
  metric: MetricKey;
  comparator: Comparator;
  threshold: number;
  for_minutes: number;
  started_at: Date;
  start_value: number | null;
  resolved_at: Date | null;
  end_value: number | null;
  ended_by: IncidentView['endedBy'];
}

/** Each alert with when its open incident, if any, started. */
const SELECT_ALERTS = `
  SELECT a.*, i.started_at AS firing_since
  FROM alerts.alerts a
  LEFT JOIN alerts.incidents i ON i.alert_id = a.id AND i.resolved_at IS NULL`;

/** How many past incidents the history shows. */
export const HISTORY_LIMIT = 50;

/**
 * Each company's alerts: what they watch, who they email, and how they've been. Checking
 * them is AlertChecks' work, and emailing AlertDeliveries'.
 */
export class AlertRules {
  readonly #database: TenantDatabase;
  readonly #places: Places;
  readonly #metrics: LatestMetrics;
  readonly #emails: AlertEmails;
  readonly #now: () => Date;

  constructor(database: TenantDatabase, places: Places, metrics: LatestMetrics, emails: AlertEmails, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#places = places;
    this.#metrics = metrics;
    this.#emails = emails;
    this.#now = now;
  }

  /** Every alert, by name. Only those who manage alerts see whom they email. */
  async list(options: { readonly showRecipients: boolean }): Promise<AlertsOverview> {
    const rows = await this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<AlertRow>(`${SELECT_ALERTS} ORDER BY lower(a.name), a.id`);
      return rows;
    });
    const places = await this.#places.of(rows.map((row) => row.environment_id));
    return {
      metricsEnabled: this.#metrics.enabled,
      metrics: METRICS,
      alerts: rows.map((row) => toView(row, places.get(row.environment_id) ?? null, options.showRecipients)),
    };
  }

  /** The latest incidents, newest first, including those that still fire. */
  async history(): Promise<IncidentView[]> {
    const rows = await this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<IncidentRow>(
        `SELECT i.id, i.alert_id, a.name AS alert_name, a.environment_id, a.metric, a.comparator, a.threshold, a.for_minutes,
                i.started_at, i.start_value, i.resolved_at, i.end_value, i.ended_by
         FROM alerts.incidents i
         JOIN alerts.alerts a ON a.id = i.alert_id
         ORDER BY i.started_at DESC, i.id
         LIMIT $1`,
        [HISTORY_LIMIT],
      );
      return rows;
    });
    const places = await this.#places.of(rows.map((row) => row.environment_id));
    return rows.map((row) => {
      const place = places.get(row.environment_id) ?? null;
      return {
        id: row.id,
        alertId: row.alert_id,
        alertName: row.alert_name,
        environmentName: place?.environmentName ?? null,
        applicationName: place?.applicationName ?? null,
        production: place?.production ?? false,
        condition: describeCondition(conditionOf(row), { withDuration: true }),
        startedAt: row.started_at.toISOString(),
        startValue: describeValue(row.start_value, row.metric),
        resolvedAt: row.resolved_at?.toISOString() ?? null,
        endValue: row.resolved_at === null ? null : describeValue(row.end_value, row.metric),
        endedBy: row.ended_by,
      };
    });
  }

  async create(
    actor: Principal,
    input: {
      name?: unknown;
      environmentId?: unknown;
      metric?: unknown;
      comparator?: unknown;
      threshold?: unknown;
      forMinutes?: unknown;
      recipients?: unknown;
    },
  ): Promise<AlertView> {
    const name = parseAlertName(input.name);
    const environmentId = parseEnvironmentId(input.environmentId);
    const metric = parseMetric(input.metric);
    const condition: AlertCondition = {
      metric,
      comparator: parseComparator(input.comparator),
      threshold: parseThreshold(input.threshold, metric),
      forMinutes: parseForMinutes(input.forMinutes),
    };
    const recipients = parseRecipients(input.recipients);
    const place = await this.#places.find(environmentId);
    if (place === null) {
      throw new AlertError('not-found', 'There’s no such environment.');
    }
    const id = randomUUID();
    return this.#database.transaction(async (tx) => {
      await assertNameFree(tx, name, null);
      await tx.query(
        `INSERT INTO alerts.alerts
           (id, company_id, name, environment_id, metric, comparator, threshold, for_minutes, recipients, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, currentCompanyId(), name, environmentId, metric, condition.comparator, condition.threshold, condition.forMinutes, recipients, actor.userId],
      );
      await appendToOutbox(tx, [
        createDomainEvent<'AlertCreated', AlertCreatedPayload>({
          eventType: 'AlertCreated',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { ...payloadOf(id, name, condition, place), recipients: recipients.length },
        }),
      ]);
      return toView((await findAlert(tx, id))!, place, true);
    });
  }

  /**
   * Changes an alert's name, threshold, minutes, addresses, or whether it's on. What it
   * watches stays, so its emails always describe it truly. Turning it off ends any
   * incident, without an email, and a new threshold or number of minutes applies from the
   * next check.
   */
  async update(
    actor: Principal,
    idValue: unknown,
    input: { name?: unknown; threshold?: unknown; forMinutes?: unknown; recipients?: unknown; enabled?: unknown },
  ): Promise<AlertView> {
    const id = parseAlertId(idValue);
    for (const fixed of ['environmentId', 'metric', 'comparator'] as const) {
      if ((input as Record<string, unknown>)[fixed] !== undefined) {
        throw new AlertError('invalid', 'What an alert watches can’t change. Create another alert instead.');
      }
    }
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      throw new AlertError('invalid', 'Enabled must be true or false.');
    }
    const name = input.name === undefined ? null : parseAlertName(input.name);
    const forMinutes = input.forMinutes === undefined ? null : parseForMinutes(input.forMinutes);
    const recipients = input.recipients === undefined ? null : parseRecipients(input.recipients);
    const enabled = input.enabled ?? null;
    // What an alert watches never changes, so its place is named before the row is locked.
    const place = await this.#placeOf(id);
    return this.#database.transaction(async (tx) => {
      const current = await lockAlert(tx, id);
      const threshold = input.threshold === undefined ? null : parseThreshold(input.threshold, current.metric);
      const next = {
        name: name ?? current.name,
        threshold: threshold ?? current.threshold,
        forMinutes: forMinutes ?? current.for_minutes,
        recipients: recipients ?? current.recipients,
        enabled: enabled ?? current.enabled,
      };
      const changes = [
        next.name !== current.name && 'name',
        next.threshold !== current.threshold && 'threshold',
        next.forMinutes !== current.for_minutes && 'forMinutes',
        next.recipients.join(',') !== current.recipients.join(',') && 'recipients',
        next.enabled !== current.enabled && 'enabled',
      ].filter((change) => change !== false);
      if (changes.length === 0) {
        return toView((await findAlert(tx, id))!, place, true);
      }
      if (next.name !== current.name) {
        await assertNameFree(tx, next.name, id);
      }
      const turnedOff = current.enabled && !next.enabled;
      await tx.query(
        `UPDATE alerts.alerts SET
           name = $2, threshold = $3, for_minutes = $4, recipients = $5, enabled = $6, updated_at = now(),
           state = CASE WHEN $7 THEN 'ok' ELSE state END,
           pending_since = CASE WHEN $7 THEN NULL ELSE pending_since END,
           check_problem = CASE WHEN $7 THEN NULL ELSE check_problem END
         WHERE id = $1`,
        [id, next.name, next.threshold, next.forMinutes, next.recipients, next.enabled, turnedOff],
      );
      if (turnedOff) {
        await tx.query(
          `UPDATE alerts.incidents SET resolved_at = $2, end_value = NULL, ended_by = 'turned-off'
           WHERE alert_id = $1 AND resolved_at IS NULL`,
          [id, this.#now()],
        );
      }
      const condition = { ...conditionOf(current), threshold: next.threshold, forMinutes: next.forMinutes };
      await appendToOutbox(tx, [
        createDomainEvent<'AlertUpdated', AlertUpdatedPayload>({
          eventType: 'AlertUpdated',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: {
            ...payloadOf(id, next.name, condition, place ?? unknownPlace(current.environment_id)),
            enabled: next.enabled,
            recipients: next.recipients.length,
            changes,
          },
        }),
      ]);
      return toView((await findAlert(tx, id))!, place, true);
    });
  }

  /** Deletes an alert and its history. */
  async delete(actor: Principal, idValue: unknown): Promise<void> {
    const id = parseAlertId(idValue);
    const place = await this.#placeOf(id);
    await this.#database.transaction(async (tx) => {
      const current = await lockAlert(tx, id);
      await tx.query('DELETE FROM alerts.alerts WHERE id = $1', [id]);
      const events: DomainEvent[] = [
        createDomainEvent<'AlertDeleted', AlertPayload>({
          eventType: 'AlertDeleted',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: payloadOf(id, current.name, conditionOf(current), place ?? unknownPlace(current.environment_id)),
        }),
      ];
      await appendToOutbox(tx, events);
    });
  }

  /**
   * Emails every address the alert names straight away, saying it's a test, so whoever
   * set it up can check the emails arrive. Returns whether they all went.
   */
  async test(actor: Principal, idValue: unknown): Promise<TestResult> {
    const id = parseAlertId(idValue);
    const alert = await this.#database.transaction((tx) => findAlert(tx, id));
    if (alert === null) {
      throw new AlertError('not-found', 'This alert does not exist.');
    }
    const place = (await this.#places.find(alert.environment_id)) ?? unknownPlace(alert.environment_id);
    let sent = 0;
    let error: string | null = null;
    for (const to of alert.recipients) {
      try {
        await this.#emails.send({
          kind: 'test',
          to,
          companyName: actor.companyName ?? 'Your company',
          alertName: alert.name,
          applicationName: place.applicationName,
          environmentName: place.environmentName,
          production: place.production,
          condition: describeCondition(conditionOf(alert), { withDuration: true }),
          value: alert.last_checked_at === null ? 'Not checked yet' : describeValue(alert.last_value, alert.metric),
          firingSince: null,
          at: this.#now().toISOString(),
        });
        sent += 1;
      } catch (failure) {
        error ??= describeError(failure);
      }
    }
    await this.#database.transaction((tx) =>
      tx.query(
        `UPDATE alerts.alerts SET last_notified_at = CASE WHEN $2 THEN now() ELSE last_notified_at END,
           last_notification_error = $3
         WHERE id = $1`,
        [id, sent > 0, error],
      ),
    );
    return { delivered: error === null, sent, error };
  }

  /** The place an alert watches, or not-found if the company has no such alert. */
  async #placeOf(id: string): Promise<Place | null> {
    const environmentId = await this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<{ environment_id: string }>('SELECT environment_id FROM alerts.alerts WHERE id = $1', [id]);
      return rows[0]?.environment_id ?? null;
    });
    if (environmentId === null) {
      throw new AlertError('not-found', 'This alert does not exist.');
    }
    return this.#places.find(environmentId);
  }
}

export function conditionOf(row: Pick<AlertRow, 'metric' | 'comparator' | 'threshold' | 'for_minutes'>): AlertCondition {
  return { metric: row.metric, comparator: row.comparator, threshold: row.threshold, forMinutes: row.for_minutes };
}

/** What every alert event says about the alert. */
export function payloadOf(id: string, name: string, condition: AlertCondition, place: Place): AlertPayload {
  return {
    alertId: id,
    name,
    environmentId: place.environmentId,
    environmentName: place.environmentName,
    applicationId: place.applicationId,
    applicationName: place.applicationName,
    production: place.production,
    metric: condition.metric,
    comparator: condition.comparator,
    threshold: condition.threshold,
    forMinutes: condition.forMinutes,
    condition: describeCondition(condition, { withDuration: false }),
  };
}

/** Stands in for an environment the company no longer has, which shouldn't happen, as environments are never deleted. */
export function unknownPlace(environmentId: string): Place {
  return { environmentId, environmentName: 'an unknown environment', applicationId: '', applicationName: 'an unknown application', production: false };
}

async function findAlert(tx: TenantTransaction, id: string): Promise<AlertRow | null> {
  const { rows } = await tx.query<AlertRow>(`${SELECT_ALERTS} WHERE a.id = $1`, [id]);
  return rows[0] ?? null;
}

async function lockAlert(tx: TenantTransaction, id: string): Promise<AlertRow> {
  const { rows } = await tx.query<AlertRow>('SELECT *, NULL AS firing_since FROM alerts.alerts WHERE id = $1 FOR UPDATE', [id]);
  if (rows[0] === undefined) {
    throw new AlertError('not-found', 'This alert does not exist.');
  }
  return rows[0];
}

async function assertNameFree(tx: TenantTransaction, name: string, exceptId: string | null): Promise<void> {
  // Serializes naming within the company, so two alerts can't take one name at once.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('alerts:names:' || kernel.current_company_id()::text, 0))");
  const { rows } = await tx.query('SELECT 1 FROM alerts.alerts WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2', [name, exceptId]);
  if (rows.length > 0) {
    throw new AlertError('conflict', 'Another alert already has this name.');
  }
}

function toView(row: AlertRow, place: Place | null, showRecipients: boolean): AlertView {
  return {
    id: row.id,
    name: row.name,
    environmentId: row.environment_id,
    environmentName: place?.environmentName ?? null,
    applicationId: place?.applicationId ?? null,
    applicationName: place?.applicationName ?? null,
    production: place?.production ?? false,
    metric: row.metric,
    comparator: row.comparator,
    threshold: row.threshold,
    forMinutes: row.for_minutes,
    condition: describeCondition(conditionOf(row), { withDuration: true }),
    recipients: showRecipients ? row.recipients : null,
    recipientCount: row.recipients.length,
    enabled: row.enabled,
    state: row.state,
    pendingSince: row.pending_since?.toISOString() ?? null,
    firingSince: row.firing_since?.toISOString() ?? null,
    lastValue: row.last_value,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    checkProblem: row.check_problem,
    lastNotifiedAt: row.last_notified_at?.toISOString() ?? null,
    lastNotificationError: row.last_notification_error,
    createdAt: row.created_at.toISOString(),
  };
}
