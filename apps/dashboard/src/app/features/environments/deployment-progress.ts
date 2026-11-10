import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { currentStep, StepList, stepsDone } from '../../shared/steps';
import { deploymentStatusName, describeDeployment, imageKindName } from './deployment-labels';
import type { Deployment } from './environments.api';

/**
 * One deployment's progress through its steps: checking the version and environment,
 * verifying the signature, pulling, starting and waiting until it's healthy.
 */
@Component({
  selector: 'app-deployment-progress',
  imports: [DatePipe, StepList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="build-progress">
      <div class="build-progress-summary">
        <progress
          [value]="done()"
          [max]="deployment().steps.length"
          [attr.aria-label]="'Progress of deployment ' + deployment().number"
        ></progress>
        <p class="cell-note" aria-live="polite">
          {{ describeDeployment(deployment()) }}: {{ deploymentStatusName(deployment().status) }}.
          {{ done() }} of {{ deployment().steps.length }} steps done.
          @if (current(); as step) {
            Now: {{ step.name }}.
          }
          @if (deployment().attempts > 1) {
            Attempt {{ deployment().attempts }}.
          }
        </p>
      </div>
      <p class="cell-note">
        #{{ deployment().number }}
        @if (deployment().imageKind !== null) {
          · {{ imageKindName(deployment().imageKind) }}
        }
        · asked for {{ deployment().createdAt | date: 'medium' }}
        @if (deployment().requestedBy?.displayName; as requester) {
          by {{ requester }}
        }
        @if (deployment().reason; as reason) {
          · “{{ reason }}”
        }
      </p>
      @if (deployment().image; as image) {
        <p class="build-image">
          <span class="muted">Image</span>
          <code>{{ image }}</code>
        </p>
      }

      <app-step-list [steps]="deployment().steps" />

      @if (deployment().status === 'succeeded' && deployment().address; as address) {
        <p>
          Open it at <a [href]="address" target="_blank" rel="noopener">{{ address }}</a>
        </p>
      }
    </div>
  `,
})
export class DeploymentProgress {
  readonly deployment = input.required<Deployment>();

  protected readonly deploymentStatusName = deploymentStatusName;
  protected readonly describeDeployment = describeDeployment;
  protected readonly imageKindName = imageKindName;

  protected readonly done = computed(() => stepsDone(this.deployment().steps));
  protected readonly current = computed(() => currentStep(this.deployment().steps));
}
