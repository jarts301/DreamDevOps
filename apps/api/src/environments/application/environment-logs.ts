/** Provides EnvironmentLogs to other contexts. */
export const ENVIRONMENT_LOGS = Symbol('ENVIRONMENT_LOGS');

/** One line the version that runs in an environment wrote. */
export interface EnvironmentLogLine {
  /** When its host received it. */
  readonly at: Date;
  /** Whether it went to standard output or to the error output. */
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

/** The host can't give the logs now. The message is safe to show. */
export class LogsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogsUnavailableError';
  }
}

/**
 * What the versions running in the current company's environments write, as other
 * contexts, such as Monitoring, read it. Another company's environment is never found.
 */
export interface EnvironmentLogs {
  /**
   * The lines the version in an environment wrote since a moment, oldest first, at most
   * `limit`. Null when there's no such environment, and none when nothing runs in it.
   */
  read(environmentId: string, options: { readonly since: Date; readonly limit: number }): Promise<EnvironmentLogLine[] | null>;
}
