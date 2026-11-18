import type { Check } from '@dreamdevops/contracts/builds/http';

// What a build's steps checked and found is Builds' published language, kept in its contracts.
export type { Check, Fact } from '@dreamdevops/contracts/builds/http';

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
