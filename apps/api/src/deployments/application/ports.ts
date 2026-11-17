/** Runs applications on targets the platform drives itself, such as This machine. */
export const HOST_RUNTIME = Symbol('HOST_RUNTIME');

/** A target, as a runtime needs it. */
export interface HostTarget {
  readonly id: string;
  /** The provider's settings, such as the host name people reach This machine by. */
  readonly settings: Readonly<Record<string, string | number>>;
}

export interface ContainerRequest {
  /** The application's container in the environment, the same for every version. */
  readonly name: string;
  /** The environment's own network. */
  readonly network: string;
  /** The image by digest, such as localhost:3000/acme/billing-api@sha256:…. */
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  /**
   * The environment variables it starts with, secrets included. Runtimes must never log
   * them, or put them where other users of the host can read them, such as a command's arguments.
   */
  readonly environment: Readonly<Record<string, string>>;
  /** The port it had before, which it keeps when it's still free, so its address stays the same. */
  readonly preferredPort: number | null;
}

/** The most a container may use, so one application can't starve its host. */
export interface ContainerLimits {
  /** CPU cores, such as 1 or 0.5. */
  readonly cpus: number;
  readonly memoryBytes: number;
}

export interface StartedContainer {
  /** The port people reach it on, or null when the image listens on none. */
  readonly port: number | null;
  readonly address: string | null;
  readonly limits: ContainerLimits;
}

export interface Health {
  readonly healthy: boolean;
  /** What the image's health check, or the container, last said. */
  readonly detail: string;
}

/** One line a container wrote, with when it was received. */
export interface LogEntry {
  readonly at: Date;
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

/**
 * Runs images on one kind of target. Every method is safe to repeat, because a deployment
 * starts again from the beginning after a temporary failure.
 */
export interface HostRuntime {
  /** Why it can't deploy on this server, such as being turned off, or null when it can. */
  unavailableReason(): string | null;
  /** Downloads the image to the host. */
  pull(target: HostTarget, image: string): Promise<void>;
  /** Starts the image as the application's container, keeping the version before it, stopped. */
  start(target: HostTarget, request: ContainerRequest): Promise<StartedContainer>;
  /** Waits until the container's health check passes, it stops, or time runs out. */
  waitUntilHealthy(target: HostTarget, name: string, timeoutMs: number): Promise<Health>;
  /** Removes the version kept for rolling back, once the new one is healthy. */
  commit(target: HostTarget, name: string): Promise<void>;
  /** Removes the new version, and starts the one before it again. Returns whether one runs again. */
  rollBack(target: HostTarget, name: string): Promise<boolean>;
  /** Stops and removes the application's containers, and the network once nothing else uses it. */
  remove(target: HostTarget, name: string, network: string): Promise<void>;
  /** The container's latest lines since a moment, oldest first. None when it doesn't exist. */
  logs(target: HostTarget, name: string, options: { readonly since: Date; readonly limit: number }): Promise<LogEntry[]>;
}

/** Retrying can't help, such as when an image can't start. The message is shown to people. */
export class PermanentDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentDeploymentError';
  }
}
