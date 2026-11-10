import type { HostingSettings } from '../domain/hosting-providers.ts';

/** Provides every HostRuntime the platform has. */
export const HOST_RUNTIMES = Symbol('HOST_RUNTIMES');

/** Provides the SecretBox that seals and opens environments' secrets. */
export const SECRET_BOX = Symbol('SECRET_BOX');

/** A hosting target, as a runtime needs it. */
export interface HostTarget {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly settings: HostingSettings;
}

export interface ContainerRequest {
  /** The environment's container name, the same for every version. */
  readonly name: string;
  /** The environment's own network. */
  readonly network: string;
  /** The image by digest, such as localhost:3000/acme/billing-api@sha256:…. */
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  /**
   * The environment variables it starts with, secrets included, opened just before it
   * starts. Runtimes must never log them, or put them where other users of the host can
   * read them, such as a command's arguments.
   */
  readonly environment: Readonly<Record<string, string>>;
  /** The port it had before, which it keeps when it's still free, so its address stays the same. */
  readonly preferredPort: number | null;
}

export interface PulledImage {
  readonly sizeBytes: number;
  /** Such as 8080/tcp. The first TCP port is the one people reach. */
  readonly exposedPorts: readonly string[];
}

export interface StartedContainer {
  /** The port people reach it on, or null when the image listens on none. */
  readonly port: number | null;
  readonly address: string | null;
  /** Whether a version ran before it. It's kept, stopped, until this one is healthy. */
  readonly replaced: boolean;
}

export interface Health {
  readonly healthy: boolean;
  /** What the image's health check, or the container, last said. */
  readonly detail: string;
}

/**
 * Runs images on one kind of hosting target. Every method is safe to repeat, because a
 * deployment starts again from the beginning after a temporary failure.
 */
export interface HostRuntime {
  /** The provider it runs for, such as local. */
  readonly provider: string;
  /** Why it can't deploy on this server, such as being turned off, or null when it can. */
  unavailableReason(): string | null;
  /** Downloads the image to the host. */
  pull(target: HostTarget, image: string): Promise<PulledImage>;
  /** Starts the image as the environment's container, keeping the version before it, stopped. */
  start(target: HostTarget, request: ContainerRequest): Promise<StartedContainer>;
  /** Waits until the container's health check passes, it stops, or time runs out. */
  waitUntilHealthy(target: HostTarget, name: string, timeoutMs: number): Promise<Health>;
  /** Removes the version kept for rolling back, once the new one is healthy. */
  commit(target: HostTarget, name: string): Promise<void>;
  /** Removes the new version, and starts the one before it again. Returns whether one runs again. */
  rollBack(target: HostTarget, name: string): Promise<boolean>;
  /** Stops and removes the environment's containers and network, if there are any. */
  remove(target: HostTarget, name: string, network: string): Promise<void>;
}

/** Retrying can't help, such as when an image can't start. The message is shown to people. */
export class PermanentDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentDeploymentError';
  }
}

/** The runtimes the platform has, by provider. Providers without one can't be deployed to yet. */
export class HostRuntimes {
  readonly #runtimes: ReadonlyMap<string, HostRuntime>;

  constructor(runtimes: readonly HostRuntime[]) {
    this.#runtimes = new Map(runtimes.map((runtime) => [runtime.provider, runtime]));
  }

  find(provider: string): HostRuntime | null {
    return this.#runtimes.get(provider) ?? null;
  }

  /** Why deployments to a provider can't run, or null when they can. */
  problem(provider: { readonly key: string; readonly name: string }): string | null {
    const runtime = this.find(provider.key);
    if (runtime === null) {
      return `Deploying to ${provider.name} targets isn’t available yet.`;
    }
    return runtime.unavailableReason();
  }
}
