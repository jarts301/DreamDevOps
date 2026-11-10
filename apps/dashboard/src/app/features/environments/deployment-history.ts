import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { errorMessage } from '../../core/api-error';
import { deploymentStatusName, deploymentTone, describeDeployment } from './deployment-labels';
import { DeploymentProgress } from './deployment-progress';
import { type Deployment, EnvironmentsApi } from './environments.api';

/**
 * An environment's deployments, newest first, with each one's steps. It loads again
 * whenever refresh changes, which the page does while a deployment is under way.
 */
@Component({
  selector: 'app-deployment-history',
  imports: [DatePipe, DeploymentProgress],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="deployment-history" [attr.aria-label]="'Deployments of ' + environmentName()">
      @if (error(); as message) {
        <p class="muted">{{ message }}</p>
      } @else if (deployments() === null) {
        <p class="muted">Loading deployments…</p>
      } @else if (deployments()!.length === 0) {
        <p class="muted">Nothing was deployed to {{ environmentName() }} yet.</p>
      } @else {
        <ul class="build-list">
          @for (deployment of deployments(); track deployment.id) {
            <li class="build-row">
              <div class="build-row-header">
                <div>
                  <strong>{{ describeDeployment(deployment) }}</strong>&ngsp;
                  <span class="status" [attr.data-tone]="deploymentTone(deployment.status)">
                    {{ deploymentStatusName(deployment.status) }}
                  </span>
                  <p class="cell-note">#{{ deployment.number }}, {{ deployment.createdAt | date: 'medium' }}</p>
                </div>
                <button
                  type="button"
                  class="button"
                  [attr.aria-expanded]="isExpanded(deployment)"
                  [attr.aria-label]="(isExpanded(deployment) ? 'Hide steps of deployment ' : 'Show steps of deployment ') + deployment.number"
                  (click)="toggle(deployment)"
                >
                  {{ isExpanded(deployment) ? 'Hide steps' : 'Show steps' }}
                </button>
              </div>
              @if (isExpanded(deployment)) {
                <app-deployment-progress [deployment]="deployment" />
              }
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class DeploymentHistory {
  readonly #api = inject(EnvironmentsApi);

  readonly environmentId = input.required<string>();
  readonly environmentName = input.required<string>();
  /** Changes when the deployments may have changed, so they load again. */
  readonly refresh = input<string>('');

  protected readonly deployments = signal<Deployment[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  protected readonly deploymentStatusName = deploymentStatusName;
  protected readonly deploymentTone = deploymentTone;
  protected readonly describeDeployment = describeDeployment;

  constructor() {
    effect(() => {
      const id = this.environmentId();
      this.refresh();
      untracked(() => void this.#load(id));
    });
  }

  protected isExpanded(deployment: Deployment): boolean {
    return this.expanded().has(deployment.id);
  }

  protected toggle(deployment: Deployment): void {
    const next = new Set(this.expanded());
    if (!next.delete(deployment.id)) {
      next.add(deployment.id);
    }
    this.expanded.set(next);
  }

  async #load(environmentId: string): Promise<void> {
    try {
      const deployments = await this.#api.deployments(environmentId);
      if (environmentId !== this.environmentId()) {
        return;
      }
      const newest = deployments[0];
      // The newest one opens, so its progress shows without a click.
      if (newest !== undefined && !this.deployments()?.some((deployment) => deployment.id === newest.id)) {
        this.expanded.set(new Set([...this.expanded(), newest.id]));
      }
      this.deployments.set(deployments);
      this.error.set(null);
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }
}
