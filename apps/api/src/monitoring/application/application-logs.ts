import type { Deployments } from '../../deployments/application/deployments.ts';
import { MonitoringError } from '../domain/errors.ts';
import { type LogLine, MAX_LOG_LINES, parseLogLine } from '../domain/logs.ts';
import { parseRange, type TimeRangeKey } from '../domain/metrics.ts';
import { type LogEntry, type LogStore, LogsUnavailableError } from './ports.ts';
import type { RunningPlaces } from './running-places.ts';

const NOT_SET_UP = 'This server doesn’t keep the logs of applications in clusters. An administrator can set it up with LOKI_URL.';

export interface EnvironmentLogView {
  readonly placeId: string;
  /** Whether a version runs there. When none does, there's nothing to read. */
  readonly running: boolean;
  readonly range: { readonly key: TimeRangeKey; readonly start: string; readonly end: string };
  /** Oldest first, the latest MAX_LOG_LINES at most. */
  readonly lines: readonly LogLine[];
}

/**
 * What applications in the company's environments write: every line of their output, with
 * its level and trace when the application logs in JSON. Clusters send their lines to the
 * platform's log store; on This machine they're read from the container. Only the current
 * company's places are ever read.
 */
export class ApplicationLogs {
  readonly #places: RunningPlaces;
  readonly #deployments: Deployments;
  readonly #store: LogStore | null;
  readonly #now: () => Date;

  constructor(places: RunningPlaces, deployments: Deployments, store: LogStore | null, now: () => Date = () => new Date()) {
    this.#places = places;
    this.#deployments = deployments;
    this.#store = store;
    this.#now = now;
  }

  /** The latest lines an application wrote in an environment within a range, such as the last hour. */
  async read(idValue: unknown, rangeValue: unknown): Promise<EnvironmentLogView> {
    const range = parseRange(rangeValue);
    const place = await this.#places.find(idValue);
    if (place === null) {
      throw new MonitoringError('not-found', 'Nothing of yours runs there.');
    }
    const end = this.#now();
    const start = new Date(end.getTime() - range.seconds * 1000);
    const options = { since: start, limit: MAX_LOG_LINES };
    let entries: LogEntry[] | null;
    try {
      entries = await this.#deployments.localLogs(place.environmentId, place.applicationId, options);
      if (entries === null) {
        if (this.#store === null) {
          throw new MonitoringError('unavailable', NOT_SET_UP);
        }
        entries = await this.#store.recent(place.placeId, options);
      }
    } catch (error) {
      if (error instanceof LogsUnavailableError) {
        throw new MonitoringError('unavailable', error.message);
      }
      throw error;
    }
    return {
      placeId: place.placeId,
      running: place.version !== null,
      range: { key: range.key, start: start.toISOString(), end: end.toISOString() },
      lines: entries.map(parseLogLine),
    };
  }
}
