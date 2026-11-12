import type { DomainEvent } from '@dreamdevops/shared-kernel';
import type { MetricKey } from '../../monitoring/domain/metrics.ts';
import type { Comparator } from './alert.ts';

/**
 * The events this module publishes. They're a contract: the audit log records them, and
 * chat rules can post AlertTriggered and AlertResolved, so their names and fields must
 * stay compatible, or come with a new event version.
 *
 * Payloads never hold the addresses an alert emails, only how many there are, so the audit
 * log and chat never show them.
 */
export interface AlertPayload {
  readonly alertId: string;
  readonly name: string;
  readonly environmentId: string;
  /** The environment's and application's names when it happened, for people reading the history. */
  readonly environmentName: string;
  readonly applicationId: string;
  readonly applicationName: string;
  readonly production: boolean;
  readonly metric: MetricKey;
  readonly comparator: Comparator;
  readonly threshold: number;
  readonly forMinutes: number;
  /** The condition in words, without its duration, such as "CPU above 80%". */
  readonly condition: string;
}

export interface AlertCreatedPayload extends AlertPayload {
  readonly recipients: number;
}

export interface AlertUpdatedPayload extends AlertPayload {
  readonly enabled: boolean;
  readonly recipients: number;
  /** What changed: name, threshold, forMinutes, recipients or enabled. */
  readonly changes: readonly string[];
}

/** The alert started firing, or a firing alert was resolved. */
export interface AlertIncidentPayload extends AlertPayload {
  readonly incidentId: string;
  /** The value that made it fire or resolve, in its metric's unit, or null when there was none. */
  readonly measured: number | null;
  /** That value in words, such as "92%", or "No data". */
  readonly value: string;
  readonly firingSince: string;
}

export interface AlertResolvedPayload extends AlertIncidentPayload {
  readonly resolvedAt: string;
}

export type AlertCreated = DomainEvent<'AlertCreated', AlertCreatedPayload>;
export type AlertUpdated = DomainEvent<'AlertUpdated', AlertUpdatedPayload>;
export type AlertDeleted = DomainEvent<'AlertDeleted', AlertPayload>;
export type AlertTriggered = DomainEvent<'AlertTriggered', AlertIncidentPayload>;
export type AlertResolved = DomainEvent<'AlertResolved', AlertResolvedPayload>;
