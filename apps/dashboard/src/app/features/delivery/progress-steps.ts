import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type StepState = 'waiting' | 'running' | 'passed' | 'failed' | 'skipped';

export interface Step {
  readonly label: string;
  readonly state: StepState;
  /** A short note, such as how far a rollout got. */
  readonly detail?: string | null;
}

const STATE_LABELS: Readonly<Record<StepState, string>> = {
  waiting: 'waiting',
  running: 'in progress',
  passed: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

const MARKERS: Readonly<Record<StepState, string>> = {
  waiting: '○',
  running: '◐',
  passed: '✓',
  failed: '✕',
  skipped: '–',
};

/** Shows the steps of a build or deployment, and where each stands. */
@Component({
  selector: 'app-progress-steps',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol class="steps" [attr.aria-label]="label()">
      @for (step of steps(); track step.label) {
        <li class="step" [attr.data-state]="step.state">
          <span class="step-marker" aria-hidden="true">{{ marker(step.state) }}</span>
          <span>{{ step.label }}<span class="visually-hidden">: {{ stateLabel(step.state) }}{{ step.detail ? ', ' : '' }}</span></span>
          @if (step.detail) {
            <span class="step-detail">{{ step.detail }}</span>
          }
        </li>
      }
    </ol>
  `,
})
export class ProgressSteps {
  readonly steps = input.required<readonly Step[]>();
  readonly label = input('Progress');

  protected marker(state: StepState): string {
    return MARKERS[state];
  }

  protected stateLabel(state: StepState): string {
    return STATE_LABELS[state];
  }
}
