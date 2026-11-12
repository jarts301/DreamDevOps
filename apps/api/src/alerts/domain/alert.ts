import { isUuid } from '@dreamdevops/shared-kernel';
import { formatMetricValue, isMetricKey, type MetricKey, METRIC_KEYS, metricOf } from '../../monitoring/domain/metrics.ts';
import { normalizeName } from '../../shared/names.ts';
import { AlertError } from './errors.ts';

/** Whether an alert fires when the metric goes above its threshold, or below it. */
export type Comparator = 'above' | 'below';

/** What an alert watches for: a metric past a threshold, for long enough. */
export interface AlertCondition {
  readonly metric: MetricKey;
  readonly comparator: Comparator;
  /** In the metric's own unit: percent, bytes, requests each second, or seconds. */
  readonly threshold: number;
  /** How long the metric must stay past the threshold before the alert fires. 0 fires at once. */
  readonly forMinutes: number;
}

export const MAX_FOR_MINUTES = 60;
export const MAX_RECIPIENTS = 10;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseAlertId(value: unknown): string {
  if (!isUuid(value)) {
    throw new AlertError('invalid', 'The alert ID is not valid.');
  }
  return value.toLowerCase();
}

export function parseEnvironmentId(value: unknown): string {
  if (!isUuid(value)) {
    throw new AlertError('invalid', 'Choose the environment to watch.');
  }
  return value.toLowerCase();
}

export function parseAlertName(value: unknown): string {
  const name = normalizeName(value, { minLength: 2, maxLength: 80, refuseControlCharacters: true });
  if (name === null) {
    throw new AlertError('invalid', 'Enter an alert name between 2 and 80 characters.');
  }
  return name;
}

export function parseMetric(value: unknown): MetricKey {
  if (!isMetricKey(value)) {
    throw new AlertError('invalid', `Choose a metric: ${METRIC_KEYS.join(', ')}.`);
  }
  return value;
}

export function parseComparator(value: unknown): Comparator {
  if (value !== 'above' && value !== 'below') {
    throw new AlertError('invalid', 'Choose whether the alert fires above or below the threshold.');
  }
  return value;
}

/** A threshold in the metric's own unit. Shares of requests can't go past 100%. */
export function parseThreshold(value: unknown, metric: MetricKey): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1e15) {
    throw new AlertError('invalid', 'Enter a threshold of zero or more.');
  }
  if (metric === 'errors' && value > 100) {
    throw new AlertError('invalid', 'Server errors are a share of requests, so their threshold is at most 100%.');
  }
  return value;
}

export function parseForMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_FOR_MINUTES) {
    throw new AlertError('invalid', `Enter how many minutes it must last, from 0 to ${MAX_FOR_MINUTES}.`);
  }
  return value;
}

/** The addresses an alert emails: at least one, at most ten, each once, in lowercase. */
export function parseRecipients(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AlertError('invalid', 'Enter at least one email address to notify.');
  }
  const recipients: string[] = [];
  for (const entry of value) {
    const email = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      throw new AlertError('invalid', `"${String(entry).slice(0, 80)}" isn't a valid email address.`);
    }
    if (!recipients.includes(email)) {
      recipients.push(email);
    }
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new AlertError('invalid', `An alert emails at most ${MAX_RECIPIENTS} addresses.`);
  }
  return recipients;
}

/**
 * Whether a value is past the threshold. With no value, such as when nothing runs or the
 * application sent no metrics lately, nothing is past it, as in Prometheus.
 */
export function isPastThreshold(value: number | null, condition: Pick<AlertCondition, 'comparator' | 'threshold'>): boolean {
  if (value === null) {
    return false;
  }
  return condition.comparator === 'above' ? value > condition.threshold : value < condition.threshold;
}

/** The condition in words, such as "CPU above 80%", and with its duration, "CPU above 80% for 5 minutes". */
export function describeCondition(condition: AlertCondition, options: { readonly withDuration: boolean }): string {
  const metric = metricOf(condition.metric);
  const text = `${metric.name} ${condition.comparator} ${formatMetricValue(condition.threshold, metric.unit)}`;
  if (!options.withDuration || condition.forMinutes === 0) {
    return text;
  }
  return `${text} for ${condition.forMinutes} ${condition.forMinutes === 1 ? 'minute' : 'minutes'}`;
}

/** A value of the alert's metric in words, such as "92%", or "No data". */
export function describeValue(value: number | null, metric: MetricKey): string {
  return formatMetricValue(value, metricOf(metric).unit);
}
