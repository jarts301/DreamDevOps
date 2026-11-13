import { describe, expect, it } from 'vitest';
import { buildProgress } from '../src/builds/domain/build.ts';
import { failed, passed, warning } from '../src/shared/progress.ts';

const states = (progress: ReturnType<typeof buildProgress>) => progress.map((step) => step.state);
const dockerfile = { checks: [passed('The repository has a Dockerfile')], facts: [] };

describe('build progress', () => {
  it('runs from waiting to running to passed, as the platform checks and jobs start and report', () => {
    expect(buildProgress('feature', 'queued', {}).map((step) => step.job)).toEqual([
      'dockerfile',
      'secrets',
      'test',
      'image',
      'inspect',
      'scan',
      'sbom',
      'verify',
    ]);
    expect(states(buildProgress('feature', 'queued', {}))).toEqual(Array(8).fill('waiting'));
    const started = { secrets: '2026-11-10T10:00:00Z', test: '2026-11-10T10:00:01Z' };
    const progress = buildProgress('feature', 'running', { dockerfile, started, secrets: { found: 0, findings: [] } });

    expect(states(progress)).toEqual(['passed', 'passed', 'running', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
    expect(progress[2]).toEqual({ job: 'test', state: 'running', startedAt: '2026-11-10T10:00:01Z', checks: [] });
  });

  it('marks failing gates and the jobs the pipeline reported as failed, and skips the rest', () => {
    const failedTests = buildProgress('feature', 'failed', { dockerfile, tests: { passed: false, log: '' } });
    expect(states(failedTests)).toEqual(['passed', 'skipped', 'failed', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(failedTests[2]!.checks[0]).toMatchObject({ name: 'The tests pass', outcome: 'failed' });

    const scan = { critical: 2, high: 0, medium: 0, low: 0, unknown: 0 };
    expect(states(buildProgress('final', 'failed', { scan }))[5]).toBe('failed');
    expect(states(buildProgress('rc', 'failed', { failedJobs: ['image'] }))[3]).toBe('failed');
  });

  it("shows the platform's own checks, and fails the step that broke a rule", () => {
    const inspection = {
      checks: [failed('It runs as a non-root user', 'The image runs as root.'), passed('It has a health check')],
      facts: [],
    };
    const progress = buildProgress('feature', 'failed', { dockerfile, inspection });

    expect(progress[4]).toMatchObject({ job: 'inspect', state: 'failed' });
    expect(progress[4]!.checks).toEqual(inspection.checks);
  });

  it('passes a step with only warnings', () => {
    const withWarning = { checks: [passed('The repository has a Dockerfile'), warning('The repository has a .dockerignore file', 'x')], facts: [] };

    expect(buildProgress('feature', 'running', { dockerfile: withWarning })[0]!.state).toBe('passed');
  });

  it('has only the Dockerfile rules, the secret scan and the tests for pull request checks', () => {
    expect(buildProgress('check', 'queued', {}).map((step) => step.job)).toEqual(['dockerfile', 'secrets', 'test']);
  });
});
