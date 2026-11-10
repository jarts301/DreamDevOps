import type { SyncReport, WorkloadReport } from './platform.ts';

/** The platform marks each workload with the deployment that made it. */
export const DEPLOYMENT_ANNOTATION = 'dreamdevops.io/deployment';
export const DEPLOYMENT_LABEL = 'dreamdevops.io/application';

interface Condition {
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
}

interface Workload {
  readonly metadata: {
    readonly name: string;
    readonly namespace?: string;
    readonly generation?: number;
    readonly annotations?: Readonly<Record<string, string>>;
  };
  readonly spec?: { readonly replicas?: number };
  readonly status?: {
    readonly observedGeneration?: number | string;
    readonly phase?: string;
    readonly message?: string;
    readonly replicas?: number;
    readonly updatedReplicas?: number;
    readonly readyReplicas?: number;
    readonly availableReplicas?: number;
    readonly abort?: boolean;
    readonly pauseConditions?: readonly unknown[] | null;
    readonly conditions?: readonly Condition[];
  };
}

/** Reads an Argo Rollout, which runs rolling and blue/green deployments. */
export function rolloutReport(rollout: Workload): WorkloadReport | null {
  const deploymentId = rollout.metadata.annotations?.[DEPLOYMENT_ANNOTATION];
  if (deploymentId === undefined) {
    return null;
  }
  const status = rollout.status ?? {};
  const desired = rollout.spec?.replicas ?? 1;
  // Until the controller has seen the newest change, its status is about an older one.
  const current = String(status.observedGeneration) === String(rollout.metadata.generation);
  let phase: WorkloadReport['phase'];
  if (!current) {
    phase = 'Progressing';
  } else if (status.abort === true) {
    phase = 'Aborted';
  } else if (status.phase === 'Healthy') {
    phase = 'Healthy';
  } else if (status.phase === 'Paused' || (status.pauseConditions?.length ?? 0) > 0) {
    phase = 'Paused';
  } else if (status.phase === 'Degraded') {
    phase = 'Degraded';
  } else {
    phase = 'Progressing';
  }
  return {
    deploymentId,
    namespace: rollout.metadata.namespace ?? '',
    name: rollout.metadata.name,
    kind: 'Rollout',
    phase,
    desired,
    updated: status.updatedReplicas ?? 0,
    ready: status.readyReplicas ?? 0,
    available: status.availableReplicas ?? 0,
    message: status.message || null,
  };
}

/** Reads a plain Deployment, which runs recreate deployments. */
export function deploymentReport(deployment: Workload): WorkloadReport | null {
  const deploymentId = deployment.metadata.annotations?.[DEPLOYMENT_ANNOTATION];
  if (deploymentId === undefined) {
    return null;
  }
  const status = deployment.status ?? {};
  const desired = deployment.spec?.replicas ?? 1;
  const progressing = status.conditions?.find((condition) => condition.type === 'Progressing');
  const current = Number(status.observedGeneration ?? 0) >= (deployment.metadata.generation ?? 0);
  let phase: WorkloadReport['phase'];
  if (!current) {
    phase = 'Progressing';
  } else if (progressing?.status === 'False') {
    phase = 'Degraded';
  } else if (
    (status.updatedReplicas ?? 0) === desired &&
    (status.availableReplicas ?? 0) === desired &&
    (status.replicas ?? 0) === desired
  ) {
    phase = 'Healthy';
  } else {
    phase = 'Progressing';
  }
  return {
    deploymentId,
    namespace: deployment.metadata.namespace ?? '',
    name: deployment.metadata.name,
    kind: 'Deployment',
    phase,
    desired,
    updated: status.updatedReplicas ?? 0,
    ready: status.readyReplicas ?? 0,
    available: status.availableReplicas ?? 0,
    message: phase === 'Degraded' ? (progressing?.message ?? null) : null,
  };
}

/** Reads Flux's Kustomization: which commit of the environment repository is applied. */
export function syncReport(kustomization: Workload & { status?: { lastAppliedRevision?: string } } | null): SyncReport | null {
  if (kustomization === null) {
    return null;
  }
  const ready = kustomization.status?.conditions?.find((condition) => condition.type === 'Ready');
  const revision = (kustomization.status as { lastAppliedRevision?: string } | undefined)?.lastAppliedRevision ?? null;
  return {
    // Flux writes "main@sha1:<commit>".
    revision: revision?.split(':').at(-1) ?? null,
    ready: ready?.status === 'True',
    message: ready?.status === 'True' ? null : (ready?.message?.slice(0, 500) ?? null),
  };
}
