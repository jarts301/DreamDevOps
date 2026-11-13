import { PROGRESSIVE_STRATEGIES, STANDARD_STRATEGIES, type Strategy } from './manifests.ts';
import { DeploymentError } from './errors.ts';

export type DeploymentStatus =
  | 'awaiting-approval'
  | 'rejected'
  | 'queued'
  | 'committed'
  | 'progressing'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'aborted'
  | 'superseded';

/** Still running: nothing else may deploy the same application to the same environment. */
export const ACTIVE_STATUSES: readonly DeploymentStatus[] = ['awaiting-approval', 'queued', 'committed', 'progressing', 'paused'];
/** In the target already: the agent's reports move these along. */
export const ROLLING_OUT: readonly DeploymentStatus[] = ['committed', 'progressing', 'paused'];

export function parseStrategy(value: unknown): Strategy {
  if (typeof value !== 'string' || ![...STANDARD_STRATEGIES, ...PROGRESSIVE_STRATEGIES].includes(value as Strategy)) {
    throw new DeploymentError('invalid', 'Choose recreate, rolling or blue/green.');
  }
  return value as Strategy;
}

export function isProgressive(strategy: Strategy): boolean {
  return PROGRESSIVE_STRATEGIES.includes(strategy);
}

/** Test environments take feature images only when they accept them; production takes final images only. */
export function assertAccepts(
  environment: { readonly name: string; readonly kind: 'test' | 'production'; readonly acceptsFeatureImages: boolean },
  build: { readonly kind: string; readonly status: string },
): void {
  if (build.status !== 'succeeded') {
    throw new DeploymentError('conflict', 'Only versions that passed every check can be deployed.');
  }
  if (environment.kind === 'production' && build.kind !== 'final') {
    throw new DeploymentError('conflict', 'Production takes final versions only.');
  }
  if (build.kind === 'feature' && !environment.acceptsFeatureImages) {
    throw new DeploymentError('conflict', `${environment.name} doesn't accept feature images.`);
  }
  if (build.kind === 'check') {
    throw new DeploymentError('conflict', 'This build is a pull request check, not a version.');
  }
}

/** What the agent saw of the deployment's workload in the cluster. */
export interface WorkloadReport {
  readonly deploymentId: string;
  readonly phase: 'Progressing' | 'Paused' | 'Healthy' | 'Degraded' | 'Aborted';
  readonly desired: number;
  readonly updated: number;
  readonly ready: number;
  readonly available: number;
  readonly message: string | null;
}

export interface SyncReport {
  readonly revision: string | null;
  readonly ready: boolean;
  readonly message: string | null;
}

export interface Progress {
  /** Flux applied the commit with this deployment. */
  readonly applied: boolean;
  readonly desired?: number;
  readonly updated?: number;
  readonly ready?: number;
  readonly available?: number;
}

/**
 * Where a deployment stands after a report from its target. A workload with its ID means
 * Flux applied it; until then, Flux's own trouble is the message.
 */
export function advance(
  current: { readonly status: DeploymentStatus; readonly commitSha: string | null },
  workload: WorkloadReport | undefined,
  sync: SyncReport | null,
): { status: DeploymentStatus; progress: Progress; message: string | null } {
  if (workload === undefined) {
    const applied = sync !== null && sync.revision !== null && sync.revision === current.commitSha;
    const message = sync !== null && !sync.ready && sync.message !== null ? `Flux can't apply the change: ${sync.message}` : null;
    return { status: current.status, progress: { applied }, message };
  }
  const progress: Progress = {
    applied: true,
    desired: workload.desired,
    updated: workload.updated,
    ready: workload.ready,
    available: workload.available,
  };
  switch (workload.phase) {
    case 'Healthy':
      return { status: 'succeeded', progress, message: null };
    case 'Paused':
      return { status: 'paused', progress, message: 'The new version is up on the preview service. Switch traffic when it looks right.' };
    case 'Degraded':
      return { status: 'failed', progress, message: workload.message ?? 'The new version did not become healthy.' };
    case 'Aborted':
      return { status: 'aborted', progress, message: 'Aborted: traffic is back on the previous version.' };
    default:
      return { status: 'progressing', progress, message: null };
  }
}
