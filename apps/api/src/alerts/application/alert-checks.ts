import { randomUUID } from 'node:crypto';
import { AlertResolved, AlertTriggered } from '@dreamdevops/contracts/alerts/events';
import { currentCompanyId, type DomainEvent, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type { LatestMetrics } from '@dreamdevops/contracts/monitoring/services';
import type { MetricKey } from '@dreamdevops/contracts/monitoring/metrics';
import type { CompanyDirectory } from '@dreamdevops/contracts/tenancy/services';
import { type Comparator, describeValue, isPastThreshold } from '../domain/alert.ts';
import { type AlertState, type AlertStatus, nextStatus } from '../domain/evaluation.ts';
import { conditionOf, payloadOf } from './alert-rules.ts';
import type { Place, Places } from './places.ts';

interface WatchedRow {
  id: string;
  name: string;
  place_id: string;
  environment_id: string;
  application_id: string;
  metric: MetricKey;
  comparator: Comparator;
  threshold: number;
  for_minutes: number;
  state: AlertState;
  pending_since: Date | null;
}

/** What one check of a company's alerts did. */
export interface CheckSummary {
  readonly checked: number;
  readonly triggered: number;
  readonly resolved: number;
  /** Why the metrics couldn't be read, if they couldn't. Alerts then keep their state. */
  readonly problem: string | null;
}

const NOTHING_CHECKED: CheckSummary = { checked: 0, triggered: 0, resolved: 0, problem: null };

/** Platform-wide reads run in a placeholder company, which matches no company's rows. */
const NO_COMPANY = parseCompanyId('00000000-0000-0000-0000-000000000000');

const SELECT_WATCHED = `
  SELECT id, name, place_id, environment_id, application_id, metric, comparator, threshold, for_minutes, state, pending_since
  FROM alerts.alerts WHERE enabled`;

/**
 * Checks alerts against the latest metrics, about once a minute. An alert fires once its
 * metric has stayed past the threshold for its minutes, and is resolved when it's back.
 * Each change is saved with its event, which is what gets people emailed.
 */
export class AlertChecks {
  readonly #database: TenantDatabase;
  readonly #companies: CompanyDirectory;
  readonly #places: Places;
  readonly #metrics: LatestMetrics;
  readonly #now: () => Date;

  constructor(
    database: TenantDatabase,
    companies: CompanyDirectory,
    places: Places,
    metrics: LatestMetrics,
    now: () => Date = () => new Date(),
  ) {
    this.#database = database;
    this.#companies = companies;
    this.#places = places;
    this.#metrics = metrics;
    this.#now = now;
  }

  /** The active companies with an alert that's on. Suspended companies' alerts wait. */
  async companiesToCheck(): Promise<string[]> {
    if (!this.#metrics.enabled) {
      return [];
    }
    // One query for every company, rather than one for each, every minute.
    const watching = await runWithCompany(NO_COMPANY, () =>
      this.#database.transaction(async (tx) => {
        const { rows } = await tx.query<{ company_id: string }>('SELECT company_id FROM alerts.companies_with_enabled_alerts()');
        return new Set(rows.map((row) => row.company_id));
      }),
    );
    if (watching.size === 0) {
      return [];
    }
    return (await this.#companies.all())
      .filter((company) => company.status === 'active' && watching.has(company.id))
      .map((company) => company.id);
  }

  /** Checks the current company's alerts that are on. */
  async check(): Promise<CheckSummary> {
    const now = this.#now();
    const watched = await this.#database.transaction(async (tx) => (await tx.query<WatchedRow>(SELECT_WATCHED)).rows);
    if (watched.length === 0) {
      return NOTHING_CHECKED;
    }
    const placeIds = [...new Set(watched.map((alert) => alert.place_id))];
    const answer = await this.#metrics.of(placeIds);
    if (answer.status === 'not-set-up') {
      return NOTHING_CHECKED;
    }
    if (answer.status === 'unavailable') {
      // Without values, nothing is known to have changed, so every alert keeps its state.
      await this.#database.transaction((tx) =>
        tx.query('UPDATE alerts.alerts SET check_problem = $1 WHERE enabled AND place_id = ANY ($2)', [answer.problem, placeIds]),
      );
      return { ...NOTHING_CHECKED, problem: answer.problem };
    }
    const valueOf = (alert: Pick<WatchedRow, 'place_id' | 'metric'>) => answer.values.get(alert.place_id)?.[alert.metric] ?? null;

    // Names go into the events, and are read before any row is locked, for the alerts
    // that look about to change.
    const changing = watched.filter(
      (alert) => nextStatus(statusOf(alert), isPastThreshold(valueOf(alert), alert), alert.for_minutes, now).transition !== null,
    );
    const places = await this.#places.of(changing);

    return this.#database.transaction(async (tx) => {
      // Locked and read again, so a change someone made meanwhile, such as a new threshold, counts.
      const { rows } = await tx.query<WatchedRow>(`${SELECT_WATCHED} AND place_id = ANY ($1) FOR UPDATE`, [placeIds]);
      const events: DomainEvent[] = [];
      let triggered = 0;
      let resolved = 0;
      for (const alert of rows) {
        const value = valueOf(alert);
        const { status, transition } = nextStatus(statusOf(alert), isPastThreshold(value, alert), alert.for_minutes, now);
        const place = places.get(alert.place_id);
        if (transition !== null && place === undefined) {
          // It changed only after the names were read. The next check, a minute later, takes it.
          continue;
        }
        await tx.query(
          `UPDATE alerts.alerts SET state = $2, pending_since = $3, last_value = $4, last_checked_at = $5, check_problem = NULL
           WHERE id = $1`,
          [alert.id, status.state, status.pendingSince, value, now],
        );
        if (transition === 'triggered') {
          const incidentId = randomUUID();
          await tx.query(
            `INSERT INTO alerts.incidents (id, company_id, alert_id, started_at, start_value) VALUES ($1, $2, $3, $4, $5)`,
            [incidentId, currentCompanyId(), alert.id, now, value],
          );
          events.push(incidentEvent(alert, place!, { incidentId, value, firingSince: now }));
          triggered += 1;
        } else if (transition === 'resolved') {
          const { rows: ended } = await tx.query<{ id: string; started_at: Date }>(
            `UPDATE alerts.incidents SET resolved_at = $2, end_value = $3, ended_by = 'recovered'
             WHERE alert_id = $1 AND resolved_at IS NULL
             RETURNING id, started_at`,
            [alert.id, now, value],
          );
          const incident = ended[0];
          if (incident !== undefined) {
            events.push(
              incidentEvent(alert, place!, { incidentId: incident.id, value, firingSince: incident.started_at }, now),
            );
            resolved += 1;
          }
        }
      }
      await appendToOutbox(tx, events);
      return { checked: rows.length, triggered, resolved, problem: null };
    });
  }
}

function statusOf(alert: Pick<WatchedRow, 'state' | 'pending_since'>): AlertStatus {
  return { state: alert.state, pendingSince: alert.pending_since };
}

/** The alert started firing, or, given when, it was resolved. */
function incidentEvent(
  alert: WatchedRow,
  place: Place,
  incident: { readonly incidentId: string; readonly value: number | null; readonly firingSince: Date },
  resolvedAt?: Date,
): DomainEvent {
  const payload = {
    ...payloadOf(alert.id, alert.name, conditionOf(alert), place),
    incidentId: incident.incidentId,
    measured: incident.value,
    value: describeValue(incident.value, alert.metric),
    firingSince: incident.firingSince.toISOString(),
  };
  // The platform noticed it, not a person.
  return resolvedAt === undefined
    ? AlertTriggered.create({ companyId: currentCompanyId(), actorId: null, payload })
    : AlertResolved.create({ companyId: currentCompanyId(), actorId: null, payload: { ...payload, resolvedAt: resolvedAt.toISOString() } });
}
