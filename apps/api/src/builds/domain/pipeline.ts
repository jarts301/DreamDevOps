import { pendingSteps, type StepRecord as GenericStepRecord } from '../../shared/progress.ts';
import type { BuildKind } from './versions.ts';

/** The steps a build goes through, in order. Their keys are stored, so they must never change. */
export type StepKey = 'checkout' | 'validate' | 'build' | 'inspect' | 'scan' | 'publish' | 'sign' | 'verify' | 'tag';

export const STEP_NAMES: Readonly<Record<StepKey, string>> = {
  checkout: 'Get the source',
  validate: 'Validate the version and Dockerfile',
  build: 'Build the image',
  inspect: 'Check the image',
  scan: 'Scan for vulnerabilities',
  publish: 'Publish to the registry',
  sign: 'Sign the image',
  verify: 'Verify the signature',
  tag: 'Tag the release in Git',
};

const COMMON_STEPS: readonly StepKey[] = ['checkout', 'validate', 'build', 'inspect', 'scan', 'publish', 'sign', 'verify'];

/** Only a release gets a Git tag, because only a release is a version of what's in production. */
export function stepsFor(kind: BuildKind): readonly StepKey[] {
  return kind === 'release' ? [...COMMON_STEPS, 'tag'] : COMMON_STEPS;
}

export type { Check, Fact, StepOutcome, StepStatus } from '../../shared/progress.ts';
export { failed, failures, passed, warning } from '../../shared/progress.ts';

export type StepRecord = GenericStepRecord<StepKey>;

export function initialSteps(kind: BuildKind): StepRecord[] {
  return pendingSteps(stepsFor(kind));
}
