import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { currentStep, StepList, stepsDone } from '../../shared/steps';
import { buildStatusName, kindName } from './build-labels';
import type { Build } from './builds.api';

/**
 * One build's progress through its steps, with every check each step made and what it
 * found, such as the digest it published or the key that signed it.
 */
@Component({
  selector: 'app-build-progress',
  imports: [StepList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="build-progress">
      <div class="build-progress-summary">
        <progress [value]="done()" [max]="build().steps.length" [attr.aria-label]="'Progress of ' + build().version"></progress>
        <p class="cell-note" aria-live="polite">
          {{ kindName(build().kind) }} {{ build().version }}: {{ buildStatusName(build().status) }}.
          {{ done() }} of {{ build().steps.length }} steps done.
          @if (current(); as step) {
            Now: {{ step.name }}.
          }
          @if (build().attempts > 1) {
            Attempt {{ build().attempts }}.
          }
        </p>
      </div>

      @if (build().image && build().digest) {
        <p class="build-image">
          <span class="muted">Image</span>
          <code>{{ build().image }}</code>
          <code class="cell-note">{{ build().digest }}</code>
        </p>
      }

      <app-step-list [steps]="build().steps" />

      @if (build().status === 'failed' && canRetry()) {
        <button
          type="button"
          class="button"
          [attr.aria-label]="'Try building ' + build().version + ' again'"
          [disabled]="working()"
          (click)="retry.emit(build())"
        >
          Try again
        </button>
      }
    </div>
  `,
})
export class BuildProgress {
  readonly build = input.required<Build>();
  readonly canRetry = input(false);
  readonly working = input(false);
  readonly retry = output<Build>();

  protected readonly kindName = kindName;
  protected readonly buildStatusName = buildStatusName;

  protected readonly done = computed(() => stepsDone(this.build().steps));
  protected readonly current = computed(() => currentStep(this.build().steps));
}
