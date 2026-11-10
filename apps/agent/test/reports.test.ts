import { describe, expect, it } from 'vitest';
import { deploymentReport, rolloutReport, syncReport } from '../src/reports.ts';

const annotated = { annotations: { 'dreamdevops.io/deployment': 'd-1' } };

describe('reports', () => {
  it('read how a rollout is doing', () => {
    const rollout = (status: object, generation = 2) => ({
      metadata: { name: 'billing', namespace: 'billing', generation, ...annotated },
      spec: { replicas: 3 },
      status: { observedGeneration: '2', replicas: 3, updatedReplicas: 1, readyReplicas: 3, availableReplicas: 3, ...status },
    });

    expect(rolloutReport(rollout({ phase: 'Progressing' }))).toMatchObject({
      deploymentId: 'd-1',
      phase: 'Progressing',
      desired: 3,
      updated: 1,
    });
    expect(rolloutReport(rollout({ phase: 'Paused', pauseConditions: [{ reason: 'BlueGreenPause' }] }))?.phase).toBe('Paused');
    expect(rolloutReport(rollout({ phase: 'Healthy' }))?.phase).toBe('Healthy');
    // A rollout the controller hasn't seen at its newest generation yet is still going.
    expect(rolloutReport(rollout({ phase: 'Healthy' }, 3))?.phase).toBe('Progressing');
    expect(rolloutReport(rollout({ phase: 'Degraded', message: 'ProgressDeadlineExceeded' }))).toMatchObject({
      phase: 'Degraded',
      message: 'ProgressDeadlineExceeded',
    });
    expect(rolloutReport(rollout({ abort: true, phase: 'Degraded' }))?.phase).toBe('Aborted');
    // A failure from before the newest change says nothing about it.
    expect(rolloutReport(rollout({ phase: 'Degraded' }, 3))?.phase).toBe('Progressing');
    expect(rolloutReport({ metadata: { name: 'other' } })).toBeNull();
  });

  it('read how a recreate deployment is doing', () => {
    const deployment = (status: object) => ({
      metadata: { name: 'billing', namespace: 'billing', generation: 4, ...annotated },
      spec: { replicas: 2 },
      status: { observedGeneration: 4, replicas: 2, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2, ...status },
    });

    expect(deploymentReport(deployment({}))?.phase).toBe('Healthy');
    expect(deploymentReport(deployment({ availableReplicas: 0 }))?.phase).toBe('Progressing');
    expect(
      deploymentReport(deployment({ conditions: [{ type: 'Progressing', status: 'False', message: 'deadline exceeded' }] })),
    ).toMatchObject({ phase: 'Degraded', message: 'deadline exceeded' });
  });

  it('read which commit Flux applied', () => {
    const kustomization = (ready: string) => ({
      metadata: { name: 'environment' },
      status: {
        lastAppliedRevision: 'main@sha1:abc123',
        conditions: [{ type: 'Ready', status: ready, message: 'failed to apply' }],
      },
    });

    expect(syncReport(kustomization('True'))).toEqual({ revision: 'abc123', ready: true, message: null });
    expect(syncReport(kustomization('False'))).toEqual({ revision: 'abc123', ready: false, message: 'failed to apply' });
    expect(syncReport(null)).toBeNull();
  });
});
