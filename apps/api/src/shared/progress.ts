/**
 * The progress of work that runs in steps, such as a build or a deployment. Steps are
 * saved as they go, so people can follow them, and each says what it checked and found.
 */

export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

/** One rule a step checked. A warning is shown but doesn't stop the work. */
export interface Check {
  readonly name: string;
  readonly outcome: 'passed' | 'failed' | 'warning';
  readonly detail: string | null;
}

/** Something a step found out, such as the digest it published. */
export interface Fact {
  readonly label: string;
  readonly value: string;
}

export interface StepRecord<Key extends string = string> {
  readonly key: Key;
  readonly status: StepStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** One sentence for people, such as why the step failed. */
  readonly summary: string | null;
  readonly checks: readonly Check[];
  readonly facts: readonly Fact[];
}

/** What a step reports when it finishes. */
export interface StepOutcome {
  readonly summary?: string;
  readonly checks?: readonly Check[];
  readonly facts?: readonly Fact[];
  /** The step had nothing to do, such as scanning on a server where it's turned off. */
  readonly skipped?: boolean;
}

/** Every step waiting, in order. */
export function pendingSteps<Key extends string>(keys: readonly Key[]): StepRecord<Key>[] {
  return keys.map((key) => ({ key, status: 'pending', startedAt: null, finishedAt: null, summary: null, checks: [], facts: [] }));
}

/** A step as it finishes, with what it reported. */
export function finishStep<Key extends string>(
  step: StepRecord<Key>,
  status: StepStatus,
  outcome: StepOutcome,
): StepRecord<Key> {
  return {
    ...step,
    status,
    finishedAt: new Date().toISOString(),
    summary: outcome.summary ?? null,
    checks: outcome.checks ?? [],
    facts: outcome.facts ?? [],
  };
}

export function passed(name: string, detail: string | null = null): Check {
  return { name, outcome: 'passed', detail };
}

export function failed(name: string, detail: string): Check {
  return { name, outcome: 'failed', detail };
}

export function warning(name: string, detail: string): Check {
  return { name, outcome: 'warning', detail };
}

export function failures(checks: readonly Check[]): Check[] {
  return checks.filter((check) => check.outcome === 'failed');
}
