import type { MetricKey } from '@dreamdevops/contracts/monitoring/metrics';
import { currentCompanyId } from '@dreamdevops/shared-kernel';
import { PostgresSession, type TenantDatabase, transactional } from '@dreamdevops/shared-kernel/postgres';
import type { AlertsSession, AlertsStore, NewAlert, StoredAlert, StoredIncident, WatchedAlert } from '../application/ports.ts';
import type { Comparator } from '../domain/alert.ts';
import type { AlertState } from '../domain/evaluation.ts';

interface AlertRow {
  id: string;
  name: string;
  place_id: string;
  environment_id: string;
  application_id: string;
  metric: MetricKey;
  comparator: Comparator;
  threshold: number;
  for_minutes: number;
  recipient_ids: string[];
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

type WatchedRow = Pick<
  AlertRow,
  'id' | 'name' | 'place_id' | 'environment_id' | 'application_id' | 'metric' | 'comparator' | 'threshold' | 'for_minutes' | 'state' | 'pending_since'
>;

/** Each alert with when its open incident, if any, started. */
const SELECT_ALERTS = `
  SELECT a.*, i.started_at AS firing_since
  FROM alerts.alerts a
  LEFT JOIN alerts.incidents i ON i.alert_id = a.id AND i.resolved_at IS NULL`;

const SELECT_WATCHED = `
  SELECT id, name, place_id, environment_id, application_id, metric, comparator, threshold, for_minutes, state, pending_since
  FROM alerts.alerts WHERE enabled`;

/** Each company's alerts and their incidents, in the alerts schema. */
export function postgresAlertsStore(database: TenantDatabase): AlertsStore {
  return transactional(database, (tx) => new PostgresAlertsSession(tx), { role: 'dreamdevops_alerts' });
}

class PostgresAlertsSession extends PostgresSession implements AlertsSession {
  async list(): Promise<StoredAlert[]> {
    const { rows } = await this.tx.query<AlertRow>(`${SELECT_ALERTS} ORDER BY lower(a.name), a.id`);
    return rows.map(toAlert);
  }

  async find(id: string): Promise<StoredAlert | null> {
    const { rows } = await this.tx.query<AlertRow>(`${SELECT_ALERTS} WHERE a.id = $1`, [id]);
    return rows[0] === undefined ? null : toAlert(rows[0]);
  }

  async lock(id: string): Promise<StoredAlert | null> {
    const { rows } = await this.tx.query<AlertRow>('SELECT *, NULL AS firing_since FROM alerts.alerts WHERE id = $1 FOR UPDATE', [id]);
    return rows[0] === undefined ? null : toAlert(rows[0]);
  }

  async placeOf(id: string): Promise<{ readonly environmentId: string; readonly applicationId: string } | null> {
    const { rows } = await this.tx.query<{ environment_id: string; application_id: string }>(
      'SELECT environment_id, application_id FROM alerts.alerts WHERE id = $1',
      [id],
    );
    return rows[0] === undefined ? null : { environmentId: rows[0].environment_id, applicationId: rows[0].application_id };
  }

  async lockNames(): Promise<void> {
    await this.tx.query("SELECT pg_advisory_xact_lock(hashtextextended('alerts:names:' || kernel.current_company_id()::text, 0))");
  }

  async isNameTaken(name: string, exceptId: string | null): Promise<boolean> {
    const { rows } = await this.tx.query('SELECT 1 FROM alerts.alerts WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2', [
      name,
      exceptId,
    ]);
    return rows.length > 0;
  }

  async add(alert: NewAlert): Promise<void> {
    await this.tx.query(
      `INSERT INTO alerts.alerts
         (id, company_id, name, place_id, environment_id, application_id, metric, comparator, threshold, for_minutes,
          recipient_ids, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        alert.id,
        currentCompanyId(),
        alert.name,
        alert.placeId,
        alert.environmentId,
        alert.applicationId,
        alert.metric,
        alert.comparator,
        alert.threshold,
        alert.forMinutes,
        alert.recipientIds,
        alert.createdBy,
      ],
    );
  }

  async update(
    id: string,
    changes: {
      readonly name: string;
      readonly threshold: number;
      readonly forMinutes: number;
      readonly recipientIds: readonly string[];
      readonly enabled: boolean;
      readonly turnedOff: boolean;
    },
  ): Promise<void> {
    await this.tx.query(
      `UPDATE alerts.alerts SET
         name = $2, threshold = $3, for_minutes = $4, recipient_ids = $5, enabled = $6, updated_at = now(),
         state = CASE WHEN $7 THEN 'ok' ELSE state END,
         pending_since = CASE WHEN $7 THEN NULL ELSE pending_since END,
         check_problem = CASE WHEN $7 THEN NULL ELSE check_problem END
       WHERE id = $1`,
      [id, changes.name, changes.threshold, changes.forMinutes, changes.recipientIds, changes.enabled, changes.turnedOff],
    );
  }

  async delete(id: string): Promise<void> {
    await this.tx.query('DELETE FROM alerts.alerts WHERE id = $1', [id]);
  }

  async forgetMember(userId: string): Promise<void> {
    await this.tx.query(
      `UPDATE alerts.alerts SET recipient_ids = array_remove(recipient_ids, $1::uuid), updated_at = now()
       WHERE $1::uuid = ANY (recipient_ids)`,
      [userId],
    );
  }

  async history(limit: number): Promise<StoredIncident[]> {
    const { rows } = await this.tx.query<{
      id: string;
      alert_id: string;
      alert_name: string;
      place_id: string;
      environment_id: string;
      application_id: string;
      metric: MetricKey;
      comparator: Comparator;
      threshold: number;
      for_minutes: number;
      started_at: Date;
      start_value: number | null;
      resolved_at: Date | null;
      end_value: number | null;
      ended_by: StoredIncident['endedBy'];
    }>(
      `SELECT i.id, i.alert_id, a.name AS alert_name, a.place_id, a.environment_id, a.application_id, a.metric, a.comparator,
              a.threshold, a.for_minutes,
              i.started_at, i.start_value, i.resolved_at, i.end_value, i.ended_by
       FROM alerts.incidents i
       JOIN alerts.alerts a ON a.id = i.alert_id
       ORDER BY i.started_at DESC, i.id
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      id: row.id,
      alertId: row.alert_id,
      alertName: row.alert_name,
      placeId: row.place_id,
      environmentId: row.environment_id,
      applicationId: row.application_id,
      metric: row.metric,
      comparator: row.comparator,
      threshold: row.threshold,
      forMinutes: row.for_minutes,
      startedAt: row.started_at,
      startValue: row.start_value,
      resolvedAt: row.resolved_at,
      endValue: row.end_value,
      endedBy: row.ended_by,
    }));
  }

  async recordNotification(id: string, outcome: { readonly notified: boolean; readonly error: string | null }): Promise<void> {
    await this.tx.query(
      `UPDATE alerts.alerts SET last_notified_at = CASE WHEN $2 THEN now() ELSE last_notified_at END,
         last_notification_error = $3
       WHERE id = $1`,
      [id, outcome.notified, outcome.error],
    );
  }

  async watched(): Promise<WatchedAlert[]> {
    const { rows } = await this.tx.query<WatchedRow>(SELECT_WATCHED);
    return rows.map(toWatched);
  }

  async lockWatched(placeIds: readonly string[]): Promise<WatchedAlert[]> {
    const { rows } = await this.tx.query<WatchedRow>(`${SELECT_WATCHED} AND place_id = ANY ($1) FOR UPDATE`, [placeIds]);
    return rows.map(toWatched);
  }

  async recordCheckProblem(placeIds: readonly string[], problem: string): Promise<void> {
    await this.tx.query('UPDATE alerts.alerts SET check_problem = $1 WHERE enabled AND place_id = ANY ($2)', [problem, placeIds]);
  }

  async recordCheck(
    id: string,
    check: { readonly state: AlertState; readonly pendingSince: Date | null; readonly value: number | null; readonly checkedAt: Date },
  ): Promise<void> {
    await this.tx.query(
      `UPDATE alerts.alerts SET state = $2, pending_since = $3, last_value = $4, last_checked_at = $5, check_problem = NULL
       WHERE id = $1`,
      [id, check.state, check.pendingSince, check.value, check.checkedAt],
    );
  }

  async openIncident(alertId: string, incident: { readonly id: string; readonly startedAt: Date; readonly value: number | null }): Promise<void> {
    await this.tx.query('INSERT INTO alerts.incidents (id, company_id, alert_id, started_at, start_value) VALUES ($1, $2, $3, $4, $5)', [
      incident.id,
      currentCompanyId(),
      alertId,
      incident.startedAt,
      incident.value,
    ]);
  }

  async endIncident(
    alertId: string,
    end: { readonly at: Date; readonly value: number | null; readonly endedBy: 'recovered' | 'turned-off' },
  ): Promise<{ readonly id: string; readonly startedAt: Date } | null> {
    const { rows } = await this.tx.query<{ id: string; started_at: Date }>(
      `UPDATE alerts.incidents SET resolved_at = $2, end_value = $3, ended_by = $4
       WHERE alert_id = $1 AND resolved_at IS NULL
       RETURNING id, started_at`,
      [alertId, end.at, end.value, end.endedBy],
    );
    return rows[0] === undefined ? null : { id: rows[0].id, startedAt: rows[0].started_at };
  }

  async companiesWithEnabledAlerts(): Promise<string[]> {
    const { rows } = await this.tx.query<{ company_id: string }>('SELECT company_id FROM alerts.companies_with_enabled_alerts()');
    return rows.map((row) => row.company_id);
  }
}

function toAlert(row: AlertRow): StoredAlert {
  return {
    id: row.id,
    name: row.name,
    placeId: row.place_id,
    environmentId: row.environment_id,
    applicationId: row.application_id,
    metric: row.metric,
    comparator: row.comparator,
    threshold: row.threshold,
    forMinutes: row.for_minutes,
    recipientIds: row.recipient_ids,
    enabled: row.enabled,
    state: row.state,
    pendingSince: row.pending_since,
    lastValue: row.last_value,
    lastCheckedAt: row.last_checked_at,
    checkProblem: row.check_problem,
    lastNotifiedAt: row.last_notified_at,
    lastNotificationError: row.last_notification_error,
    createdAt: row.created_at,
    firingSince: row.firing_since,
  };
}

function toWatched(row: WatchedRow): WatchedAlert {
  return {
    id: row.id,
    name: row.name,
    placeId: row.place_id,
    environmentId: row.environment_id,
    applicationId: row.application_id,
    metric: row.metric,
    comparator: row.comparator,
    threshold: row.threshold,
    forMinutes: row.for_minutes,
    state: row.state,
    pendingSince: row.pending_since,
  };
}
