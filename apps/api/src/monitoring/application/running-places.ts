import { isUuid } from '@dreamdevops/shared-kernel';
import type { RunningVersions, RunningVersion } from '@dreamdevops/contracts/deployments/services';
import { placeId } from '@dreamdevops/contracts/environments/telemetry';

/** One application running in one environment: what Monitoring shows, and what its telemetry is labelled by. */
export interface RunningPlace {
  readonly placeId: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly applicationId: string;
  readonly applicationName: string;
  /** The application's short name, which its traces are found by. */
  readonly applicationSlug: string;
  readonly production: boolean;
  readonly version: string | null;
  readonly since: string | null;
  readonly address: string | null;
  /** What runs the environment, such as kubernetes, or local for This machine. */
  readonly provider: string | null;
  /** The most CPU and memory it has, to set what it uses against, or null when unknown. */
  readonly limits: { readonly cpus: number; readonly memoryBytes: number } | null;
}

/**
 * What runs in the current company's environments, as places. RunningVersions knows what
 * runs; this only names each one by its place, so the stores can be asked about it.
 */
export class RunningPlaces {
  readonly #deployments: RunningVersions;

  constructor(deployments: RunningVersions) {
    this.#deployments = deployments;
  }

  async list(): Promise<RunningPlace[]> {
    return (await this.#deployments.running({})).map(toPlace);
  }

  /** One place, if something runs there in the current company. */
  async find(id: unknown): Promise<RunningPlace | null> {
    if (!isUuid(id)) {
      return null;
    }
    return (await this.list()).find((place) => place.placeId === id.toLowerCase()) ?? null;
  }
}

function toPlace(running: RunningVersion): RunningPlace {
  const cpus = running.limits === null ? null : cpuCores(running.limits.cpu);
  const memoryBytes = running.limits === null ? null : bytes(running.limits.memory);
  return {
    placeId: placeId(running.environment.id, running.application.id),
    environmentId: running.environment.id,
    environmentName: running.environment.name,
    applicationId: running.application.id,
    applicationName: running.application.name,
    applicationSlug: running.application.slug,
    production: running.environment.kind === 'production',
    version: running.version.version ?? running.version.tag,
    since: running.since,
    address: running.address,
    provider: running.provider,
    limits: cpus === null || memoryBytes === null ? null : { cpus, memoryBytes },
  };
}

/** Kubernetes CPU quantities, such as 250m or 1, in cores. */
export function cpuCores(quantity: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(m?)$/.exec(quantity.trim());
  if (match === null) {
    return null;
  }
  return Number(match[1]) / (match[2] === 'm' ? 1000 : 1);
}

const UNITS: Readonly<Record<string, number>> = { '': 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, k: 1000, M: 1000 ** 2, G: 1000 ** 3 };

/** Kubernetes memory quantities, such as 256Mi or 1Gi, in bytes. */
export function bytes(quantity: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|k|M|G)?$/.exec(quantity.trim());
  if (match === null) {
    return null;
  }
  return Math.round(Number(match[1]) * UNITS[match[2] ?? '']!);
}
