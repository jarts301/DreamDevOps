import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Work that runs in steps, such as a build or a deployment, as the API reports it. */
export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

/** One rule a step checked. A warning is shown but doesn't stop the work. */
export interface Check {
  readonly name: string;
  readonly outcome: 'passed' | 'failed' | 'warning';
  readonly detail: string | null;
}

/** Something a step found out, such as a digest or an address. */
export interface Fact {
  readonly label: string;
  readonly value: string;
}

export interface Step {
  readonly key: string;
  readonly name: string;
  readonly status: StepStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly summary: string | null;
  readonly checks: readonly Check[];
  readonly facts: readonly Fact[];
}

const STEP_STATUS_NAMES: Readonly<Record<StepStatus, string>> = {
  pending: 'Waiting',
  running: 'In progress',
  passed: 'Passed',
  failed: 'Failed',
  skipped: 'Skipped',
};

/** Shown beside each step's name. The text says the same, so color and symbols are never needed. */
const STEP_SYMBOLS: Readonly<Record<StepStatus, string>> = {
  pending: '○',
  running: '◐',
  passed: '✓',
  failed: '✗',
  skipped: '–',
};

const OUTCOME_NAMES: Readonly<Record<Check['outcome'], string>> = { passed: 'Passed', failed: 'Failed', warning: 'Warning' };
const OUTCOME_SYMBOLS: Readonly<Record<Check['outcome'], string>> = { passed: '✓', failed: '✗', warning: '!' };

export const stepStatusName = (status: StepStatus): string => STEP_STATUS_NAMES[status] ?? status;
export const stepSymbol = (status: StepStatus): string => STEP_SYMBOLS[status] ?? '';

/** How a status badge looks: done, failed, under way, or plain. The text always says the same. */
export type Tone = 'success' | 'danger' | 'progress' | null;

export function stepTone(status: StepStatus): Tone {
  switch (status) {
    case 'passed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'running':
      return 'progress';
    default:
      return null;
  }
}

/** How long something took, such as "42s" or "3m 05s". */
export function duration(startedAt: string | null, finishedAt: string | null, now = Date.now()): string | null {
  if (startedAt === null) {
    return null;
  }
  const end = finishedAt === null ? now : Date.parse(finishedAt);
  const seconds = Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** How many steps are done, passed or skipped. */
export function stepsDone(steps: readonly Step[]): number {
  return steps.filter((step) => step.status === 'passed' || step.status === 'skipped').length;
}

/** The step under way, if any. */
export function currentStep(steps: readonly Step[]): Step | null {
  return steps.find((step) => step.status === 'running') ?? null;
}

/**
 * Steps in order, each with its status, how long it took, every check it made and what
 * it found, such as the digest it published or the address it started at.
 */
@Component({
  selector: 'app-step-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol class="pipeline">
      @for (step of steps(); track step.key) {
        <li class="pipeline-step" [attr.data-status]="step.status">
          <div class="pipeline-step-header">
            <span class="pipeline-symbol" aria-hidden="true">{{ stepSymbol(step.status) }}</span>
            <span class="pipeline-name">{{ step.name }}</span>
            <span class="visually-hidden">: </span>
            <span class="status" [attr.data-tone]="stepTone(step.status)">{{ stepStatusName(step.status) }}</span>
            @if (took(step); as time) {
              <span class="cell-note"><span class="visually-hidden">, took </span>{{ time }}</span>
            }
          </div>
          @if (step.summary) {
            <p class="cell-note step-summary">{{ step.summary }}</p>
          }
          @if (step.checks.length > 0) {
            <ul class="check-list" [attr.aria-label]="'Checks for ' + step.name">
              @for (check of step.checks; track check.name) {
                <li [attr.data-outcome]="check.outcome">
                  <span class="check-symbol" aria-hidden="true">{{ outcomeSymbol(check) }}</span>
                  <span class="visually-hidden">{{ outcomeName(check) }}: </span>
                  <span>{{ check.name }}</span>
                  @if (check.detail) {
                    <span class="cell-note check-detail"><span class="visually-hidden">. </span>{{ check.detail }}</span>
                  }
                </li>
              }
            </ul>
          }
          @if (step.facts.length > 0) {
            <dl class="fact-list">
              @for (fact of step.facts; track fact.label) {
                <div>
                  <dt>{{ fact.label }}</dt>
                  <dd><code>{{ fact.value }}</code></dd>
                </div>
              }
            </dl>
          }
        </li>
      }
    </ol>
  `,
})
export class StepList {
  readonly steps = input.required<readonly Step[]>();

  protected readonly stepStatusName = stepStatusName;
  protected readonly stepSymbol = stepSymbol;
  protected readonly stepTone = stepTone;

  protected took(step: Step): string | null {
    return step.status === 'pending' ? null : duration(step.startedAt, step.finishedAt);
  }

  protected outcomeName(check: Check): string {
    return OUTCOME_NAMES[check.outcome];
  }

  protected outcomeSymbol(check: Check): string {
    return OUTCOME_SYMBOLS[check.outcome];
  }
}
