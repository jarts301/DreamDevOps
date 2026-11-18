import type { RunningVersion } from './http.ts';

/** What Deployments answers for other contexts: what runs where. */

// What runs where is also what the HTTP API answers, so it's defined there.
export type { ResourceLimits, RunningVersion } from './http.ts';

/** A line an application wrote. */
export interface LogEntry {
  readonly at: Date;
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export const RUNNING_VERSIONS = Symbol('RUNNING_VERSIONS');

/** What runs in the current company's environments, for contexts such as Monitoring. */
export interface RunningVersions {
  /** What runs now, by environment or application, or everywhere. */
  running(filter: { readonly application?: unknown; readonly environment?: unknown }): Promise<RunningVersion[]>;
  /**
   * The latest lines an application on This machine wrote, or null when it doesn't run on
   * This machine. Clusters' logs go to the platform's log store instead.
   */
  localLogs(
    environmentId: string,
    applicationId: string,
    options: { readonly since: Date; readonly limit: number },
  ): Promise<LogEntry[] | null>;
}

