import { ALERTS_EVENTS } from './alerts/events.ts';
import { BUILDS_EVENTS } from './builds/events.ts';
import { CATALOG_EVENTS } from './catalog/events.ts';
import { DEPLOYMENTS_EVENTS } from './deployments/events.ts';
import { EDITIONS_EVENTS } from './editions/events.ts';
import { ENVIRONMENTS_EVENTS } from './environments/events.ts';
import type { EventDefinition } from './event.ts';
import { IDENTITY_ACCESS_EVENTS } from './identity-access/events.ts';
import { NOTIFICATIONS_EVENTS } from './notifications/events.ts';
import { RELEASES_EVENTS } from './releases/events.ts';
import { SOURCE_GOVERNANCE_EVENTS } from './source-governance/events.ts';
import { TENANCY_EVENTS } from './tenancy/events.ts';
import { WEBHOOKS_EVENTS } from './webhooks/events.ts';

const PUBLISHED = [
  ...IDENTITY_ACCESS_EVENTS,
  ...TENANCY_EVENTS,
  ...EDITIONS_EVENTS,
  ...CATALOG_EVENTS,
  ...SOURCE_GOVERNANCE_EVENTS,
  ...WEBHOOKS_EVENTS,
  ...BUILDS_EVENTS,
  ...RELEASES_EVENTS,
  ...ENVIRONMENTS_EVENTS,
  ...DEPLOYMENTS_EVENTS,
  ...ALERTS_EVENTS,
  ...NOTIFICATIONS_EVENTS,
] as unknown as readonly EventDefinition<string, object>[];

/**
 * Every event the platform publishes, in the version publishers publish now, by type.
 * Consumers that handle every event, such as the audit log and chat notifications, read
 * them here, so they need no knowledge of any one context's events.
 */
export const EVENT_CATALOG: ReadonlyMap<string, EventDefinition<string, object>> = new Map(
  PUBLISHED.map((definition) => [definition.type, definition]),
);

if (EVENT_CATALOG.size !== PUBLISHED.length) {
  const types = PUBLISHED.map((definition) => definition.type);
  const twice = types.filter((type, index) => types.indexOf(type) !== index);
  throw new Error(`The event catalog lists ${twice.join(', ')} more than once. List only the version publishers publish now.`);
}

/**
 * A recorded event in words, for the history, such as 'Registered the application
 * "Billing API"'. An event of a type or shape this version doesn't know, such as one
 * recorded under an older contract, is still named, by its description or its type.
 */
export function describeRecordedEvent(eventType: string, payload: unknown): string {
  const definition = EVENT_CATALOG.get(eventType);
  if (definition === undefined) {
    return eventType;
  }
  const checked = definition.payload.safeParse(payload);
  return checked.success ? definition.describe(checked.data) : definition.description;
}

/** An event in one sentence, for a chat message, or its description when its payload can't be read. */
export function summarizeRecordedEvent(eventType: string, payload: unknown): string {
  const definition = EVENT_CATALOG.get(eventType);
  if (definition === undefined) {
    return `${eventType} happened.`;
  }
  const checked = definition.payload.safeParse(payload);
  return checked.success ? definition.summarize(checked.data) : `${definition.description}.`;
}
