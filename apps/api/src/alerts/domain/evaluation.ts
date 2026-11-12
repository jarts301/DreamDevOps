/**
 * An alert is ok, pending while its metric is past the threshold but not yet for long
 * enough, or firing. It fires once the metric has stayed past the threshold for its
 * minutes, and is resolved as soon as a check finds it back.
 */
export type AlertState = 'ok' | 'pending' | 'firing';

export interface AlertStatus {
  readonly state: AlertState;
  /** When the metric went past the threshold, while pending. */
  readonly pendingSince: Date | null;
}

/** What a check changed that people hear about: the alert started firing, or was resolved. */
export type Transition = 'triggered' | 'resolved' | null;

/** How often alerts are checked. */
export const CHECK_INTERVAL_SECONDS = 60;

/**
 * Checks run about once a minute, never exactly, so a check a few seconds early still
 * counts a minute as passed. Otherwise an alert for 1 minute could wait for 2.
 */
const CHECK_TOLERANCE_MS = 10_000;

export const OK: AlertStatus = { state: 'ok', pendingSince: null };

/** The alert's status after a check found its metric past the threshold, or not, at a time. */
export function nextStatus(
  current: AlertStatus,
  pastThreshold: boolean,
  forMinutes: number,
  now: Date,
): { readonly status: AlertStatus; readonly transition: Transition } {
  if (!pastThreshold) {
    return { status: OK, transition: current.state === 'firing' ? 'resolved' : null };
  }
  if (current.state === 'firing') {
    return { status: current, transition: null };
  }
  const since = current.state === 'pending' && current.pendingSince !== null ? current.pendingSince : now;
  if (now.getTime() - since.getTime() >= forMinutes * 60_000 - CHECK_TOLERANCE_MS) {
    return { status: { state: 'firing', pendingSince: null }, transition: 'triggered' };
  }
  return { status: { state: 'pending', pendingSince: since }, transition: null };
}
