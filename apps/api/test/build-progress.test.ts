import { describe, expect, it } from 'vitest';
import { buildProgress } from '../src/builds/domain/build.ts';

const states = (progress: ReturnType<typeof buildProgress>) => progress.map((step) => step.state);

describe('build progress', () => {
  it('runs from waiting to running to passed, as jobs start and report', () => {
    expect(states(buildProgress('feature', 'queued', {}))).toEqual(['waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
    const started = { secrets: '2026-11-10T10:00:00Z', test: '2026-11-10T10:00:01Z' };
    const progress = buildProgress('feature', 'running', { started, secrets: { found: 0, findings: [] } });

    expect(states(progress)).toEqual(['passed', 'running', 'waiting', 'waiting', 'waiting']);
    expect(progress[1]).toEqual({ job: 'test', state: 'running', startedAt: '2026-11-10T10:00:01Z' });
  });

  it('marks failing gates and the jobs the pipeline reported as failed, and skips the rest', () => {
    const failedTests = buildProgress('feature', 'failed', { tests: { passed: false, log: '' } });
    expect(states(failedTests)).toEqual(['skipped', 'failed', 'skipped', 'skipped', 'skipped']);

    const scan = { critical: 2, high: 0, medium: 0, low: 0, unknown: 0 };
    expect(states(buildProgress('final', 'failed', { scan }))).toEqual(['skipped', 'skipped', 'skipped', 'failed', 'skipped']);
    expect(states(buildProgress('rc', 'failed', { failedJobs: ['image'] }))).toEqual([
      'skipped',
      'skipped',
      'failed',
      'skipped',
      'skipped',
    ]);
  });

  it('has only the secret scan and tests for pull request checks', () => {
    expect(buildProgress('check', 'queued', {}).map((step) => step.job)).toEqual(['secrets', 'test']);
  });
});
