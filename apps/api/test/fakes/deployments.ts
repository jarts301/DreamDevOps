import type {
  ContainerRequest,
  Health,
  HostRuntime,
  HostTarget,
  LogEntry,
  StartedContainer,
} from '../../src/deployments/application/ports.ts';
import { PermanentDeploymentError } from '../../src/deployments/application/ports.ts';

interface FakeContainer {
  readonly request: ContainerRequest;
  readonly port: number;
  running: boolean;
}

/** Plays This machine's Docker in memory: containers start at once, and health is up to the test. */
export class FakeHostRuntime implements HostRuntime {
  readonly pulled: string[] = [];
  readonly containers = new Map<string, FakeContainer>();
  readonly removed: string[] = [];
  /** What the next health check says. */
  health: Health = { healthy: true, detail: 'Its health check passed.' };
  /** A message to refuse the next start with, as Docker would for an image that can't start. */
  refuseStart: string | null = null;
  enabled = true;
  #ports = 49_152;

  unavailableReason(): string | null {
    return this.enabled ? null : 'Running applications on this machine is turned off on this server.';
  }

  async pull(_target: HostTarget, image: string): Promise<void> {
    this.pulled.push(image);
  }

  async start(target: HostTarget, request: ContainerRequest): Promise<StartedContainer> {
    if (this.refuseStart !== null) {
      throw new PermanentDeploymentError(this.refuseStart);
    }
    const before = this.containers.get(request.name);
    if (before !== undefined) {
      before.running = false;
      this.containers.set(`${request.name}-previous`, before);
    }
    const port = request.preferredPort ?? (this.#ports += 1);
    this.containers.set(request.name, { request, port, running: true });
    const host = typeof target.settings['publicHost'] === 'string' ? target.settings['publicHost'] : 'localhost';
    return { port, address: `http://${host}:${port}`, limits: { cpus: 1, memoryBytes: 512 * 1024 * 1024 } };
  }

  async waitUntilHealthy(): Promise<Health> {
    return this.health;
  }

  async commit(_target: HostTarget, name: string): Promise<void> {
    this.containers.delete(`${name}-previous`);
  }

  async rollBack(_target: HostTarget, name: string): Promise<boolean> {
    this.containers.delete(name);
    const previous = this.containers.get(`${name}-previous`);
    this.containers.delete(`${name}-previous`);
    if (previous === undefined) {
      return false;
    }
    previous.running = true;
    this.containers.set(name, previous);
    return true;
  }

  async remove(_target: HostTarget, name: string, network: string): Promise<void> {
    this.containers.delete(name);
    this.containers.delete(`${name}-previous`);
    this.removed.push(name, network);
  }

  async logs(): Promise<LogEntry[]> {
    return [];
  }

  /** The one container the test's environment has, by its labels. */
  find(application: string, environment: string): FakeContainer | undefined {
    return [...this.containers.values()].find(
      (container) =>
        container.request.labels['dreamdevops.application'] === application &&
        container.request.labels['dreamdevops.environment'] === environment &&
        container.running,
    );
  }
}
