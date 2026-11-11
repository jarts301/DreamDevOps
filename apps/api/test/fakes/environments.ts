import type {
  ContainerRequest,
  Health,
  HostRuntime,
  HostTarget,
  LogEntry,
  PulledImage,
  StartedContainer,
} from '../../src/environments/application/ports.ts';

interface FakeContainer {
  readonly image: string;
  running: boolean;
  readonly port: number | null;
  readonly labels: Readonly<Record<string, string>>;
  /** The variables it started with, as a container would have them. */
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * A host in memory that runs containers the way the local Docker runtime does: the
 * version before is kept, stopped, until the new one is healthy.
 */
export class FakeHostRuntime implements HostRuntime {
  readonly provider: string;
  enabled = true;
  /** Containers by target and name, such as "target-id/dreamdevops-billing-staging-…". */
  readonly containers = new Map<string, FakeContainer>();
  readonly calls: string[] = [];
  /** Images that never become healthy. */
  readonly unhealthy = new Set<string>();
  /** Errors to throw, one per call, before calls start succeeding. */
  readonly failures: Error[] = [];
  /** What each container wrote, by target and name, such as "target-id/dreamdevops-billing-staging-…". */
  readonly written = new Map<string, LogEntry[]>();
  /** The options of each read of the logs. */
  readonly logReads: { name: string; since: Date; limit: number }[] = [];
  /** While set, pulling waits for it, so tests can look at a deployment under way. */
  gate: Promise<void> | null = null;
  #nextPort = 20_000;

  constructor(provider = 'local') {
    this.provider = provider;
  }

  /** Makes pulling wait until the returned function is called. */
  hold(): () => void {
    let release = () => {};
    this.gate = new Promise((resolve) => {
      release = () => {
        this.gate = null;
        resolve();
      };
    });
    return release;
  }

  /** What runs on a target, by container name. */
  running(targetId: string): { name: string; image: string; port: number | null }[] {
    return [...this.containers.entries()]
      .filter(([key, container]) => key.startsWith(`${targetId}/`) && container.running)
      .map(([key, container]) => ({ name: key.slice(targetId.length + 1), image: container.image, port: container.port }));
  }

  /** The variables of what runs on a target, if one thing runs there. */
  environmentOf(targetId: string): Readonly<Record<string, string>> | undefined {
    return [...this.containers.entries()].find(([key, container]) => key.startsWith(`${targetId}/`) && container.running)?.[1]
      .environment;
  }

  unavailableReason(): string | null {
    return this.enabled ? null : 'Running applications on this host is turned off.';
  }

  async pull(target: HostTarget, image: string): Promise<PulledImage> {
    this.#record('pull', target, image);
    await this.gate;
    return { sizeBytes: 123_400_000, exposedPorts: ['8080/tcp'] };
  }

  async start(target: HostTarget, request: ContainerRequest): Promise<StartedContainer> {
    this.#record('start', target, request.name);
    const key = `${target.id}/${request.name}`;
    const previous = `${key}-previous`;
    const current = this.containers.get(key);
    if (current !== undefined && this.containers.has(previous)) {
      this.containers.delete(key);
    } else if (current !== undefined) {
      this.containers.delete(key);
      this.containers.set(previous, { ...current, running: false });
    }
    const port = request.preferredPort ?? this.#nextPort++;
    this.containers.set(key, {
      image: request.image,
      running: true,
      port,
      labels: request.labels,
      environment: { ...request.environment },
    });
    return {
      port,
      address: `http://localhost:${port}`,
      replaced: this.containers.has(previous),
      limits: { cpus: 1, memoryBytes: 512 * 1024 * 1024 },
    };
  }

  async waitUntilHealthy(target: HostTarget, name: string): Promise<Health> {
    this.#record('health', target, name);
    const container = this.containers.get(`${target.id}/${name}`);
    if (container === undefined) {
      return { healthy: false, detail: 'The container is gone.' };
    }
    return this.unhealthy.has(container.image)
      ? { healthy: false, detail: 'Its health check failed. Its last health check said: connection refused' }
      : { healthy: true, detail: 'Its health check passed.' };
  }

  async commit(target: HostTarget, name: string): Promise<void> {
    this.#record('commit', target, name);
    this.containers.delete(`${target.id}/${name}-previous`);
  }

  async rollBack(target: HostTarget, name: string): Promise<boolean> {
    this.#record('rollBack', target, name);
    const key = `${target.id}/${name}`;
    this.containers.delete(key);
    const previous = this.containers.get(`${key}-previous`);
    if (previous === undefined) {
      return false;
    }
    this.containers.delete(`${key}-previous`);
    this.containers.set(key, { ...previous, running: true });
    return true;
  }

  async remove(target: HostTarget, name: string): Promise<void> {
    this.#record('remove', target, name);
    this.containers.delete(`${target.id}/${name}`);
    this.containers.delete(`${target.id}/${name}-previous`);
  }

  async logs(target: HostTarget, name: string, options: { since: Date; limit: number }): Promise<LogEntry[]> {
    this.logReads.push({ name, since: options.since, limit: options.limit });
    const key = `${target.id}/${name}`;
    if (!this.containers.has(key)) {
      return [];
    }
    return (this.written.get(key) ?? []).filter((entry) => entry.at >= options.since).slice(-options.limit);
  }

  /** Makes what runs on a target write a line, as its application would. */
  write(targetId: string, entry: LogEntry): void {
    const key = [...this.containers.entries()].find(([candidate, container]) => candidate.startsWith(`${targetId}/`) && container.running)?.[0];
    if (key === undefined) {
      throw new Error(`Nothing runs on ${targetId}.`);
    }
    this.written.set(key, [...(this.written.get(key) ?? []), entry]);
  }

  #record(call: string, target: HostTarget, detail: string): void {
    this.calls.push(`${call} ${target.name} ${detail}`);
    const failure = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
  }
}
