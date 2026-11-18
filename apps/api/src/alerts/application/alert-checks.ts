import { randomUUID } from 'node:crypto';
import { AlertResolved, AlertTriggered } from '@dreamdevops/contracts/alerts/events';
import { currentCompanyId, type DomainEvent, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { LatestMetrics } from '@dreamdevops/contracts/monitoring/services';
import type { CompanyDirectory } from '@dreamdevops/contracts/tenancy/services';
import { describeValue, isPastThreshold } from '../domain/alert.ts';
import { type AlertStatus, nextStatus } from '../domain/evaluation.ts';
import { conditionOf, payloadOf } from './alert-rules.ts';
import type { Place, Places } from './places.ts';
import type { AlertsStore, WatchedAlert } from './ports.ts';

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

/**
 * Checks alerts against the latest metrics, about once a minute. An alert fires once its
 * metric has stayed past the threshold for its minutes, and is resolved when it's back.
 * Each change is saved with its event, which is what gets people emailed.
 */
export class AlertChecks {
  readonly #store: AlertsStore;
  readonly #companies: CompanyDirectory;
  readonly #places: Places;
  readonly #metrics: LatestMetrics;
  readonly #now: () => Date;

  constructor(
    store: AlertsStore,
    companies: CompanyDirectory,
    places: Places,
    metrics: LatestMetrics,
    now: () => Date = () => new Date(),
  ) {
    this.#store = store;
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
    const watching = new Set(
      await runWithCompany(NO_COMPANY, () => this.#store.transaction((session) => session.companiesWithEnabledAlerts())),
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
    const watched = await this.#store.transaction((session) => session.watched());
    if (watched.length === 0) {
      return NOTHING_CHECKED;
    }
    const placeIds = [...new Set(watched.map((alert) => alert.placeId))];
    const answer = await this.#metrics.of(placeIds);
    if (answer.status === 'not-set-up') {
      return NOTHING_CHECKED;
    }
    if (answer.status === 'unavailable') {
      // Without values, nothing is known to have changed, so every alert keeps its state.
      await this.#store.transaction((session) => session.recordCheckProblem(placeIds, answer.problem));
      return { ...NOTHING_CHECKED, problem: answer.problem };
    }
    const valueOf = (alert: Pick<WatchedAlert, 'placeId' | 'metric'>) => answer.values.get(alert.placeId)?.[alert.metric] ?? null;

    // Names go into the events, and are read before any row is locked, for the alerts
    // that look about to change.
    const changing = watched.filter(
      (alert) => nextStatus(statusOf(alert), isPastThreshold(valueOf(alert), alert), alert.forMinutes, now).transition !== null,
    );
    const places = await this.#places.of(changing);

    return this.#store.transaction(async (session) => {
      // Locked and read again, so a change someone made meanwhile, such as a new threshold, counts.
      const rows = await session.lockWatched(placeIds);
      const events: DomainEvent[] = [];
      let triggered = 0;
      let resolved = 0;
      for (const alert of rows) {
        const value = valueOf(alert);
        const { status, transition } = nextStatus(statusOf(alert), isPastThreshold(value, alert), alert.forMinutes, now);
        const place = places.get(alert.placeId);
        if (transition !== null && place === undefined) {
          // It changed only after the names were read. The next check, a minute later, takes it.
          continue;
        }
        await session.recordCheck(alert.id, { state: status.state, pendingSince: status.pendingSince, value, checkedAt: now });
        if (transition === 'triggered') {
          const incidentId = randomUUID();
          await session.openIncident(alert.id, { id: incidentId, startedAt: now, value });
          events.push(incidentEvent(alert, place!, { incidentId, value, firingSince: now }));
          triggered += 1;
        } else if (transition === 'resolved') {
          const incident = await session.endIncident(alert.id, { at: now, value, endedBy: 'recovered' });
          if (incident !== null) {
            events.push(incidentEvent(alert, place!, { incidentId: incident.id, value, firingSince: incident.startedAt }, now));
            resolved += 1;
          }
        }
      }
      await session.record(events);
      return { checked: rows.length, triggered, resolved, problem: null };
    });
  }
}

function statusOf(alert: Pick<WatchedAlert, 'state' | 'pendingSince'>): AlertStatus {
  return { state: alert.state, pendingSince: alert.pendingSince };
}

/** The alert started firing, or, given when, it was resolved. */
function incidentEvent(
  alert: WatchedAlert,
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
