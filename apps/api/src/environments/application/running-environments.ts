/** Provides RunningEnvironments to other contexts. */
export const RUNNING_ENVIRONMENTS = Symbol('RUNNING_ENVIRONMENTS');

/** An environment, and the version that runs in it, as contexts that watch what runs need it. */
export interface RunningEnvironment {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly applicationId: string;
  readonly production: boolean;
  /** The version that runs in it now, or null when nothing does. */
  readonly version: string | null;
  /** When that version started running. */
  readonly since: string | null;
  /** Where people reach it, if it listens on a port. */
  readonly address: string | null;
  /** The hosting target it runs on. */
  readonly targetName: string | null;
  /** What the version's container may use at most, or null when nothing runs or its host sets no limits. */
  readonly limits: { readonly cpus: number; readonly memoryBytes: number } | null;
}

/**
 * Environments' published read model of what runs where. Other contexts, such as
 * Monitoring, ask here instead of reading this context's tables. Both methods run in the
 * current company, so another company's environments are never found.
 */
export interface RunningEnvironments {
  /** The active environments a version runs in. */
  list(): Promise<RunningEnvironment[]>;
  /** One environment, whether or not anything runs in it, or null if there's no such environment. */
  find(environmentId: string): Promise<RunningEnvironment | null>;
}
