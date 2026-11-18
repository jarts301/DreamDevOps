import { randomUUID } from 'node:crypto';
import { AlertCreated, AlertDeleted, type AlertPayload, AlertUpdated } from '@dreamdevops/contracts/alerts/events';
import { currentCompanyId, describeError, type DomainEvent } from '@dreamdevops/shared-kernel';
import type { CompanyMember, CompanyMembers } from '@dreamdevops/contracts/identity-access/services';
import type { Principal } from '@dreamdevops/contracts/identity-access/access';
import type {
  AlertsOverview,
  AlertTestResult,
  AlertView,
  CreateAlert,
  IncidentView,
  Recipient,
  UpdateAlert,
} from '@dreamdevops/contracts/alerts/http';
import type { Unchecked } from '@dreamdevops/contracts/http';
import type { LatestMetrics } from '@dreamdevops/contracts/monitoring/services';
import { METRICS } from '@dreamdevops/contracts/monitoring/metrics';
import type { AlertMailer } from '@dreamdevops/contracts/notifications/services';
import {
  type AlertCondition,
  describeCondition,
  describeValue,
  parseAlertId,
  parseAlertName,
  parseApplicationId,
  parseComparator,
  parseEnvironmentId,
  parseForMinutes,
  parseMetric,
  parseRecipientIds,
  parseThreshold,
} from '../domain/alert.ts';
import { AlertError } from '../domain/errors.ts';
import { placeId } from '@dreamdevops/contracts/environments/telemetry';
import type { Place, Places } from './places.ts';
import type { AlertsSession, AlertsStore, StoredAlert } from './ports.ts';

/** How many past incidents the history shows. */
export const HISTORY_LIMIT = 50;

/**
 * Each company's alerts: what they watch, who they email, and how they've been. Checking
 * them is AlertChecks' work, and emailing AlertDeliveries'.
 */
export class AlertRules {
  readonly #store: AlertsStore;
  readonly #places: Places;
  readonly #metrics: LatestMetrics;
  readonly #emails: AlertMailer;
  readonly #members: CompanyMembers;
  readonly #now: () => Date;

  constructor(
    store: AlertsStore,
    places: Places,
    metrics: LatestMetrics,
    emails: AlertMailer,
    members: CompanyMembers,
    now: () => Date = () => new Date(),
  ) {
    this.#store = store;
    this.#places = places;
    this.#metrics = metrics;
    this.#emails = emails;
    this.#members = members;
    this.#now = now;
  }

  /** Every alert, by name. Only those who manage alerts see whom they email. */
  async list(options: { readonly showRecipients: boolean }): Promise<AlertsOverview> {
    const rows = await this.#store.transaction((session) => session.list());
    const [places, members] = await Promise.all([
      this.#places.of(rows),
      rows.length === 0 ? Promise.resolve([]) : this.#members.list(),
    ]);
    const byId = new Map(members.map((member) => [member.userId, member]));
    return {
      metricsEnabled: this.#metrics.enabled,
      metrics: METRICS,
      alerts: rows.map((row) => toView(row, places.get(row.placeId) ?? null, byId, options.showRecipients)),
    };
  }

  /** The members an alert can email: everyone in the company, by name. */
  async members(): Promise<Recipient[]> {
    return (await this.#members.list()).map(recipientOf);
  }

  /**
   * Takes someone who left the company off every alert, so they aren't emailed again, even
   * if they rejoin. Emails are only ever sent to current members anyway, so this only
   * tidies up what alerts show.
   */
  async forgetMember(userId: string): Promise<void> {
    await this.#store.transaction((session) => session.forgetMember(userId));
  }

  /** The latest incidents, newest first, including those that still fire. */
  async history(): Promise<IncidentView[]> {
    const rows = await this.#store.transaction((session) => session.history(HISTORY_LIMIT));
    const places = await this.#places.of(rows);
    return rows.map((row) => {
      const place = places.get(row.placeId) ?? null;
      return {
        id: row.id,
        alertId: row.alertId,
        alertName: row.alertName,
        environmentName: place?.environmentName ?? null,
        applicationName: place?.applicationName ?? null,
        production: place?.production ?? false,
        condition: describeCondition(conditionOf(row), { withDuration: true }),
        startedAt: row.startedAt.toISOString(),
        startValue: describeValue(row.startValue, row.metric),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        endValue: row.resolvedAt === null ? null : describeValue(row.endValue, row.metric),
        endedBy: row.endedBy,
      };
    });
  }

  async create(
    actor: Principal,
    input: Unchecked<CreateAlert>,
  ): Promise<AlertView> {
    const name = parseAlertName(input.name);
    const environmentId = parseEnvironmentId(input.environmentId);
    const applicationId = parseApplicationId(input.applicationId);
    const metric = parseMetric(input.metric);
    const condition: AlertCondition = {
      metric,
      comparator: parseComparator(input.comparator),
      threshold: parseThreshold(input.threshold, metric),
      forMinutes: parseForMinutes(input.forMinutes),
    };
    const recipients = parseRecipientIds(input.recipients);
    await this.#assertMembers(recipients);
    const place = await this.#places.find(environmentId, applicationId);
    if (place === null) {
      throw new AlertError('not-found', 'There’s no such environment or application.');
    }
    const id = randomUUID();
    const row = await this.#store.transaction(async (session) => {
      await assertNameFree(session, name, null);
      await session.add({
        id,
        name,
        placeId: placeId(environmentId, applicationId),
        environmentId,
        applicationId,
        metric,
        comparator: condition.comparator,
        threshold: condition.threshold,
        forMinutes: condition.forMinutes,
        recipientIds: recipients,
        createdBy: actor.userId,
      });
      await session.record([
        AlertCreated.create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { ...payloadOf(id, name, condition, place), recipients: recipients.length },
        }),
      ]);
      return (await session.find(id))!;
    });
    return this.#view(row, place);
  }

  /**
   * Changes an alert's name, threshold, minutes, members, or whether it's on. What it
   * watches stays, so its emails always describe it truly. Turning it off ends any
   * incident, without an email, and a new threshold or number of minutes applies from the
   * next check.
   */
  async update(
    actor: Principal,
    idValue: unknown,
    input: Unchecked<UpdateAlert>,
  ): Promise<AlertView> {
    const id = parseAlertId(idValue);
    for (const fixed of ['environmentId', 'applicationId', 'metric', 'comparator'] as const) {
      if ((input as Record<string, unknown>)[fixed] !== undefined) {
        throw new AlertError('invalid', 'What an alert watches can’t change. Create another alert instead.');
      }
    }
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      throw new AlertError('invalid', 'Enabled must be true or false.');
    }
    const name = input.name === undefined ? null : parseAlertName(input.name);
    const forMinutes = input.forMinutes === undefined ? null : parseForMinutes(input.forMinutes);
    const recipients = input.recipients === undefined ? null : parseRecipientIds(input.recipients);
    if (recipients !== null) {
      await this.#assertMembers(recipients);
    }
    const enabled = input.enabled ?? null;
    // What an alert watches never changes, so its place is named before the row is locked.
    const place = await this.#placeOf(id);
    const row = await this.#store.transaction(async (session) => {
      const current = await lockAlert(session, id);
      const threshold = input.threshold === undefined ? null : parseThreshold(input.threshold, current.metric);
      const next = {
        name: name ?? current.name,
        threshold: threshold ?? current.threshold,
        forMinutes: forMinutes ?? current.forMinutes,
        recipients: recipients ?? current.recipientIds,
        enabled: enabled ?? current.enabled,
      };
      const changes = [
        next.name !== current.name && 'name',
        next.threshold !== current.threshold && 'threshold',
        next.forMinutes !== current.forMinutes && 'forMinutes',
        next.recipients.join(',') !== current.recipientIds.join(',') && 'recipients',
        next.enabled !== current.enabled && 'enabled',
      ].filter((change) => change !== false);
      if (changes.length === 0) {
        return (await session.find(id))!;
      }
      if (next.name !== current.name) {
        await assertNameFree(session, next.name, id);
      }
      const turnedOff = current.enabled && !next.enabled;
      await session.update(id, {
        name: next.name,
        threshold: next.threshold,
        forMinutes: next.forMinutes,
        recipientIds: next.recipients,
        enabled: next.enabled,
        turnedOff,
      });
      if (turnedOff) {
        await session.endIncident(id, { at: this.#now(), value: null, endedBy: 'turned-off' });
      }
      const condition = { ...conditionOf(current), threshold: next.threshold, forMinutes: next.forMinutes };
      await session.record([
        AlertUpdated.create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: {
            ...payloadOf(id, next.name, condition, place ?? unknownPlace(current.environmentId, current.applicationId)),
            enabled: next.enabled,
            recipients: next.recipients.length,
            changes,
          },
        }),
      ]);
      return (await session.find(id))!;
    });
    return this.#view(row, place);
  }

  /** Deletes an alert and its history. */
  async delete(actor: Principal, idValue: unknown): Promise<void> {
    const id = parseAlertId(idValue);
    const place = await this.#placeOf(id);
    await this.#store.transaction(async (session) => {
      const current = await lockAlert(session, id);
      await session.delete(id);
      const events: DomainEvent[] = [
        AlertDeleted.create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: payloadOf(id, current.name, conditionOf(current), place ?? unknownPlace(current.environmentId, current.applicationId)),
        }),
      ];
      await session.record(events);
    });
  }

  /**
   * Emails every member the alert names straight away, saying it's a test, so whoever
   * set it up can check the emails arrive. Returns whether they all went.
   */
  async test(actor: Principal, idValue: unknown): Promise<AlertTestResult> {
    const id = parseAlertId(idValue);
    const alert = await this.#store.transaction((session) => session.find(id));
    if (alert === null) {
      throw new AlertError('not-found', 'This alert does not exist.');
    }
    const place = (await this.#places.find(alert.environmentId, alert.applicationId)) ?? unknownPlace(alert.environmentId, alert.applicationId);
    // Only those who are members now, at their address now.
    const recipients = await this.#members.find(alert.recipientIds);
    if (recipients.length === 0) {
      return { delivered: false, sent: 0, error: 'The alert names nobody who is still a member of the company. Choose someone to email.' };
    }
    let sent = 0;
    let error: string | null = null;
    for (const recipient of recipients) {
      try {
        await this.#emails.send({
          kind: 'test',
          to: recipient.email,
          companyName: actor.companyName ?? 'Your company',
          alertName: alert.name,
          applicationName: place.applicationName,
          environmentName: place.environmentName,
          production: place.production,
          condition: describeCondition(conditionOf(alert), { withDuration: true }),
          value: alert.lastCheckedAt === null ? 'Not checked yet' : describeValue(alert.lastValue, alert.metric),
          firingSince: null,
          at: this.#now().toISOString(),
        });
        sent += 1;
      } catch (failure) {
        error ??= describeError(failure);
      }
    }
    await this.#store.transaction((session) => session.recordNotification(id, { notified: sent > 0, error }));
    return { delivered: error === null, sent, error };
  }

  /** Refuses anyone who isn't a member of the company now. */
  async #assertMembers(userIds: readonly string[]): Promise<void> {
    const members = await this.#members.find(userIds);
    if (members.length !== userIds.length) {
      throw new AlertError('invalid', 'Choose members of the company to email. Someone chosen isn’t a member.');
    }
  }

  /** An alert as the dashboard shows it to those who manage it. */
  async #view(row: StoredAlert, place: Place | null): Promise<AlertView> {
    const members = await this.#members.find(row.recipientIds);
    return toView(row, place, new Map(members.map((member) => [member.userId, member])), true);
  }

  /** The place an alert watches, or not-found if the company has no such alert. */
  async #placeOf(id: string): Promise<Place | null> {
    const watched = await this.#store.transaction((session) => session.placeOf(id));
    if (watched === null) {
      throw new AlertError('not-found', 'This alert does not exist.');
    }
    return this.#places.find(watched.environmentId, watched.applicationId);
  }
}

export function conditionOf(alert: Pick<StoredAlert, 'metric' | 'comparator' | 'threshold' | 'forMinutes'>): AlertCondition {
  return { metric: alert.metric, comparator: alert.comparator, threshold: alert.threshold, forMinutes: alert.forMinutes };
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

/** Stands in for a place the company no longer has, which shouldn't happen, as environments and applications are never deleted. */
export function unknownPlace(environmentId: string, applicationId: string): Place {
  return {
    placeId: placeId(environmentId, applicationId),
    environmentId,
    environmentName: 'an unknown environment',
    applicationId,
    applicationName: 'an unknown application',
    production: false,
  };
}

async function lockAlert(session: AlertsSession, id: string): Promise<StoredAlert> {
  const alert = await session.lock(id);
  if (alert === null) {
    throw new AlertError('not-found', 'This alert does not exist.');
  }
  return alert;
}

async function assertNameFree(session: AlertsSession, name: string, exceptId: string | null): Promise<void> {
  // Serializes naming within the company, so two alerts can't take one name at once.
  await session.lockNames();
  if (await session.isNameTaken(name, exceptId)) {
    throw new AlertError('conflict', 'Another alert already has this name.');
  }
}

function recipientOf(member: CompanyMember): Recipient {
  return { userId: member.userId, displayName: member.displayName, email: member.email };
}

function toView(row: StoredAlert, place: Place | null, members: ReadonlyMap<string, CompanyMember>, showRecipients: boolean): AlertView {
  // Anyone who left the company is left out, until they're taken off the alert.
  const recipients = row.recipientIds.flatMap((id) => {
    const member = members.get(id);
    return member === undefined ? [] : [recipientOf(member)];
  });
  return {
    id: row.id,
    name: row.name,
    placeId: row.placeId,
    environmentId: row.environmentId,
    environmentName: place?.environmentName ?? null,
    applicationId: row.applicationId,
    applicationName: place?.applicationName ?? null,
    production: place?.production ?? false,
    metric: row.metric,
    comparator: row.comparator,
    threshold: row.threshold,
    forMinutes: row.forMinutes,
    condition: describeCondition(conditionOf(row), { withDuration: true }),
    recipients: showRecipients ? recipients : null,
    recipientCount: recipients.length,
    enabled: row.enabled,
    state: row.state,
    pendingSince: row.pendingSince?.toISOString() ?? null,
    firingSince: row.firingSince?.toISOString() ?? null,
    lastValue: row.lastValue,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    checkProblem: row.checkProblem,
    lastNotifiedAt: row.lastNotifiedAt?.toISOString() ?? null,
    lastNotificationError: row.lastNotificationError,
    createdAt: row.createdAt.toISOString(),
  };
}
