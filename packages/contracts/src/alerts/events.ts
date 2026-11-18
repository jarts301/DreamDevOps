import { z } from 'zod';
import { defineEvent, type EventOf } from '../event.ts';
import { id, name, timestamp } from '../fields.ts';

/**
 * Alerts' events. They never say whom an alert emails, only how many members, so the
 * history and chat never show anyone's address.
 */

const alert = {
  alertId: id(),
  name: name(),
  environmentId: id(),
  /** The environment's and application's names when it happened, for people reading the history. */
  environmentName: name(),
  applicationId: id(),
  applicationName: name(),
  production: z.boolean(),
  metric: z.enum(['cpu', 'memory', 'requests', 'responseTime', 'errors']),
  comparator: z.enum(['above', 'below']),
  threshold: z.number(),
  forMinutes: z.number().int().nonnegative(),
  /** The condition in words, without its duration, such as "CPU above 80%". */
  condition: z.string(),
};

/** What the alert is about and watches, as every alert event says it. */
export const AlertPayload = z.object(alert);
export type AlertPayload = z.output<typeof AlertPayload>;

/** Where an alert watches, such as 'Billing API in the production environment "Live"'. */
function place(payload: AlertPayload): string {
  return `${payload.applicationName} in the ${payload.production ? 'production ' : ''}environment "${payload.environmentName}"`;
}

const CHANGES: Readonly<Record<string, string>> = {
  name: 'its name',
  threshold: 'its threshold',
  forMinutes: 'how long it waits',
  recipients: 'whom it emails',
};

/** What changed about an alert, such as ": its threshold and whom it emails", or that it was turned on or off. */
function changed(changes: readonly string[], enabled: boolean): string {
  const parts = changes.flatMap((change) => (CHANGES[change] === undefined ? [] : [CHANGES[change]]));
  const switched = changes.includes('enabled') ? (enabled ? ', and turned it on' : ', and turned it off') : '';
  if (parts.length === 0) {
    return switched.replace(', and', ':');
  }
  const listed = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `: ${listed}${switched}`;
}

export const AlertCreated = defineEvent({
  type: 'AlertCreated',
  description: 'An alert is created',
  payload: z.object({ ...alert, recipients: z.number().int().nonnegative() }),
  describe: (payload) => `Created the alert "${payload.name}" on ${payload.condition} for ${place(payload)}`,
});

export const AlertUpdated = defineEvent({
  type: 'AlertUpdated',
  description: 'An alert is changed',
  payload: z.object({
    ...alert,
    enabled: z.boolean(),
    recipients: z.number().int().nonnegative(),
    /** What changed: name, threshold, forMinutes, recipients or enabled. */
    changes: z.array(z.string()),
  }),
  describe: (payload) => `Changed the alert "${payload.name}" for ${place(payload)}${changed(payload.changes, payload.enabled)}`,
});

export const AlertDeleted = defineEvent({
  type: 'AlertDeleted',
  description: 'An alert is deleted',
  payload: z.object(alert),
  describe: (payload) => `Deleted the alert "${payload.name}" for ${place(payload)}`,
});

const incident = {
  ...alert,
  incidentId: id(),
  /** The value that made it fire or resolve, in its metric's unit, or null when there was none. */
  measured: z.number().nullable(),
  /** That value in words, such as "92%", or "No data". */
  value: z.string(),
  firingSince: timestamp(),
};

export const AlertTriggered = defineEvent({
  type: 'AlertTriggered',
  description: 'An alert starts firing',
  payload: z.object(incident),
  describe: (payload) => `The alert "${payload.name}" fired: ${payload.condition} for ${place(payload)}, at ${payload.value}`,
  summarize: (payload) => `The alert "${payload.name}" is firing: ${place(payload)} has ${payload.condition}, at ${payload.value}.`,
});

export const AlertResolved = defineEvent({
  type: 'AlertResolved',
  description: 'A firing alert is resolved',
  payload: z.object({ ...incident, resolvedAt: timestamp() }),
  describe: (payload) =>
    `The alert "${payload.name}" was resolved: ${payload.condition} no longer holds for ${place(payload)}, at ${payload.value}`,
  summarize: (payload) =>
    `The alert "${payload.name}" is resolved: ${place(payload)} no longer has ${payload.condition}, at ${payload.value}.`,
});

export type AlertCreated = EventOf<typeof AlertCreated>;
export type AlertUpdated = EventOf<typeof AlertUpdated>;
export type AlertDeleted = EventOf<typeof AlertDeleted>;
export type AlertTriggered = EventOf<typeof AlertTriggered>;
export type AlertResolved = EventOf<typeof AlertResolved>;

export const ALERTS_EVENTS = [AlertCreated, AlertUpdated, AlertDeleted, AlertTriggered, AlertResolved] as const;
