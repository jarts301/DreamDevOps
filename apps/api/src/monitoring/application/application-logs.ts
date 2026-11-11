import {
  type EnvironmentLogs,
  LogsUnavailableError,
} from '../../environments/application/environment-logs.ts';
import type { RunningEnvironments } from '../../environments/application/running-environments.ts';
import { MonitoringError } from '../domain/errors.ts';
import { type LogLine, MAX_LOG_LINES, parseLogLine } from '../domain/logs.ts';
import { parseRange, type TimeRangeKey } from '../domain/metrics.ts';

export interface EnvironmentLogView {
  readonly environmentId: string;
  /** Whether a version runs in it. When none does, there's nothing to read. */
  readonly running: boolean;
  readonly range: { readonly key: TimeRangeKey; readonly start: string; readonly end: string };
  /** Oldest first, the latest MAX_LOG_LINES at most. */
  readonly lines: readonly LogLine[];
}

/**
 * What the versions in the company's environments write: every line of their output, with
 * its level and trace when the application logs in JSON. Only the current company's
 * environments are ever read.
 */
export class ApplicationLogs {
  readonly #environments: RunningEnvironments;
  readonly #logs: EnvironmentLogs;
  readonly #now: () => Date;

  constructor(environments: RunningEnvironments, logs: EnvironmentLogs, now: () => Date = () => new Date()) {
    this.#environments = environments;
    this.#logs = logs;
    this.#now = now;
  }

  /** The latest lines the version in an environment wrote within a range, such as the last hour. */
  async read(idValue: unknown, rangeValue: unknown): Promise<EnvironmentLogView> {
    const range = parseRange(rangeValue);
    const environment = typeof idValue === 'string' ? await this.#environments.find(idValue) : null;
    if (environment === null) {
      throw new MonitoringError('not-found', 'There’s no such environment.');
    }
    const end = this.#now();
    const start = new Date(end.getTime() - range.seconds * 1000);
    let entries;
    try {
      entries = await this.#logs.read(environment.environmentId, { since: start, limit: MAX_LOG_LINES });
    } catch (error) {
      if (error instanceof LogsUnavailableError) {
        throw new MonitoringError('unavailable', error.message);
      }
      throw error;
    }
    if (entries === null) {
      throw new MonitoringError('not-found', 'There’s no such environment.');
    }
    return {
      environmentId: environment.environmentId,
      running: environment.version !== null,
      range: { key: range.key, start: start.toISOString(), end: end.toISOString() },
      lines: entries.map(parseLogLine),
    };
  }
}
