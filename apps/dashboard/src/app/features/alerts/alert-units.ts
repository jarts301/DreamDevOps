import type { MetricUnit } from '../monitoring/monitoring.api';

const MEBIBYTE = 1024 * 1024;

/**
 * How people type a threshold for each unit: memory in MiB and response times in ms, as
 * Monitoring shows them. The API keeps bytes and seconds.
 */
const INPUT_UNITS: Readonly<Record<MetricUnit, { readonly label: string; readonly perInput: number }>> = {
  percent: { label: '%', perInput: 1 },
  bytes: { label: 'MiB', perInput: MEBIBYTE },
  'per-second': { label: 'requests/s', perInput: 1 },
  seconds: { label: 'ms', perInput: 0.001 },
};

/** The unit a threshold is typed in, such as MiB. */
export function inputUnit(unit: MetricUnit): string {
  return INPUT_UNITS[unit].label;
}

/** A typed threshold in the API's unit, such as 450 MiB in bytes. */
export function toThreshold(typed: number, unit: MetricUnit): number {
  const value = typed * INPUT_UNITS[unit].perInput;
  // 0.1 ms is 0.00010000000000000002 s in floating point, which reads oddly back.
  return Number(value.toPrecision(12));
}

/** A threshold as people type it, such as bytes in MiB. */
export function fromThreshold(threshold: number, unit: MetricUnit): number {
  return Number((threshold / INPUT_UNITS[unit].perInput).toPrecision(12));
}

/** Addresses typed in one field, separated by commas, semicolons, spaces or lines. */
export function parseAddresses(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((address) => address.trim())
    .filter((address) => address !== '');
}

/** How long an alert waits, in the choices the form offers. */
export const WAIT_CHOICES: readonly { readonly minutes: number; readonly label: string }[] = [
  { minutes: 0, label: 'At once' },
  { minutes: 1, label: 'For 1 minute' },
  { minutes: 2, label: 'For 2 minutes' },
  { minutes: 5, label: 'For 5 minutes' },
  { minutes: 10, label: 'For 10 minutes' },
  { minutes: 15, label: 'For 15 minutes' },
  { minutes: 30, label: 'For 30 minutes' },
  { minutes: 60, label: 'For 60 minutes' },
];
