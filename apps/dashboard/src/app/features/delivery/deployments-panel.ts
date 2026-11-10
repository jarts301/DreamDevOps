import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, type OnDestroy, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api-error';
import { SessionService } from '../../core/session.service';
import { type Environment, EnvironmentsApi } from '../environments/environments.api';
import { type Build, DeliveryApi, type Deployment, type DeploymentAction, type DeploymentStatus, type Strategy } from './delivery.api';
import { ProgressSteps, type Step } from './progress-steps';

const REFRESH_MS = 5_000;
const ACTIVE: readonly DeploymentStatus[] = ['awaiting-approval', 'queued', 'committed', 'progressing', 'paused'];

const STATUS_LABELS: Readonly<Record<DeploymentStatus, string>> = {
  'awaiting-approval': 'Waiting for approval',
  rejected: 'Rejected',
  queued: 'Starting',
  committed: 'Waiting for the target',
  progressing: 'Rolling out',
  paused: 'Waiting to switch traffic',
  succeeded: 'Running',
  failed: 'Failed',
  aborted: 'Aborted',
  superseded: 'Replaced by a newer deployment',
};

const STRATEGY_LABELS: Readonly<Record<Strategy, string>> = {
  recreate: 'Recreate',
  rolling: 'Rolling',
  'blue-green': 'Blue/green',
};

const ACTION_LABELS: Readonly<Record<DeploymentAction, string>> = {
  approve: 'Approve',
  reject: 'Reject',
  promote: 'Switch traffic',
  abort: 'Abort',
  rollback: 'Roll back',
};

/** The steps of a deployment, from approval to running, for people to follow. */
export function deploymentSteps(deployment: Deployment): Step[] {
  const { status, progress } = deployment;
  const failed = status === 'failed' || status === 'aborted';
  const steps: Step[] = [];
  if (status === 'awaiting-approval' || status === 'rejected' || deployment.approvedBy !== null) {
    steps.push({
      label: 'Approved',
      state: status === 'awaiting-approval' ? 'running' : status === 'rejected' ? 'failed' : 'passed',
      detail: deployment.approvedBy?.displayName ? `by ${deployment.approvedBy.displayName}` : null,
    });
  }
  const committed = deployment.commit !== null;
  steps.push({
    label: 'Saved to Git',
    state: committed ? 'passed' : status === 'queued' ? 'running' : status === 'rejected' || status === 'awaiting-approval' ? 'waiting' : 'failed',
    detail: committed ? deployment.commit!.slice(0, 7) : null,
  });
  const applied = progress.applied === true || ['progressing', 'paused', 'succeeded', 'superseded'].includes(status);
  steps.push({
    label: 'Applied by the target',
    state: applied ? 'passed' : status === 'committed' ? 'running' : failed && committed ? 'failed' : 'waiting',
  });
  const counts = progress.desired === undefined ? null : `${progress.ready ?? 0} of ${progress.desired} ready`;
  // An aborted blue/green rollout did finish; it's the traffic switch that was undone.
  const rolledOut = status === 'succeeded' || status === 'superseded' || status === 'paused' || (status === 'aborted' && deployment.strategy === 'blue-green');
  steps.push({
    label: 'Rolling out',
    state: rolledOut
        ? 'passed'
        : status === 'progressing'
          ? 'running'
          : failed && applied
            ? 'failed'
            : 'waiting',
    detail: counts,
  });
  if (deployment.strategy === 'blue-green') {
    steps.push({
      label: 'Traffic switched',
      state: status === 'succeeded' || status === 'superseded' ? 'passed' : status === 'paused' ? 'running' : status === 'aborted' ? 'failed' : 'waiting',
    });
  }
  return steps;
}

/**
 * Deployments of an application, of an environment, or both, with their progress and
 * what can be done next. With an application and its versions, it also offers a form to
 * deploy. It keeps refreshing while a deployment is under way.
 */
@Component({
  selector: 'app-deployments-panel',
  imports: [DatePipe, ProgressSteps, ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }
    @if (notice(); as message) {
      <p class="alert alert-success" role="status">{{ message }}</p>
    }

    @if (versions() !== undefined && deployable().length > 0) {
      <section class="card" aria-labelledby="deploy-heading">
        <h2 id="deploy-heading">Deploy</h2>
        <form class="form-row" [formGroup]="form" (ngSubmit)="deploy()">
          <label class="field">
            <span>Environment</span>
            <select formControlName="environment">
              @for (environment of deployable(); track environment.id) {
                <option [value]="environment.id">
                  {{ environment.name }} ({{ environment.kind === 'production' ? 'production' : 'test' }})
                </option>
              }
            </select>
          </label>
          <label class="field">
            <span>Version</span>
            <select formControlName="version">
              @for (version of acceptedVersions(); track version.id) {
                <option [value]="version.id">{{ version.version ?? version.tag }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span>Strategy</span>
            <select formControlName="strategy">
              <option value="rolling">Rolling</option>
              <option value="blue-green">Blue/green</option>
              <option value="recreate">Recreate</option>
            </select>
          </label>
          <button type="submit" class="button button-primary" [disabled]="form.invalid || working() || acceptedVersions().length === 0">
            Deploy
          </button>
        </form>
        @if (chosenEnvironment(); as environment) {
          <p class="cell-note">
            {{ environment.name }} takes {{ environment.acceptedImages.join(', ') }} images.
            @if (environment.requiresApproval) {
              Someone else must approve each deployment.
            }
            @if (acceptedVersions().length === 0) {
              There are no versions it accepts yet.
            }
          </p>
        }
        <p class="cell-note">
          Rolling replaces pods a few at a time. Blue/green starts the new version beside the old one, and you switch
          traffic when it looks right. Recreate stops the old version first, with a short downtime.
        </p>
      </section>
    }

    <section class="card" aria-labelledby="deployments-heading">
      <h2 id="deployments-heading">Deployments</h2>
      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else if (deployments().length === 0) {
        <p class="muted">No deployments yet.</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">{{ application() === undefined ? 'Application' : 'Environment' }}</th>
                <th scope="col">Progress</th>
                <th scope="col">Asked for</th>
                <th scope="col"><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (deployment of deployments(); track deployment.id) {
                <tr>
                  <td>
                    <code>{{ deployment.version.version ?? deployment.version.tag }}</code>
                    <p class="cell-note">
                      {{ strategyLabel(deployment.strategy) }}{{ deployment.rollbackOf ? ', rollback' : '' }}
                    </p>
                  </td>
                  <td>
                    @if (application() === undefined) {
                      <a [routerLink]="['/applications', deployment.application.id]">{{ deployment.application.name }}</a>
                    } @else {
                      <a [routerLink]="['/environments', deployment.environment.id]">{{ deployment.environment.name }}</a>
                    }
                  </td>
                  <td>
                    <span class="status" [attr.data-status]="statusStyle(deployment.status)">{{ statusLabel(deployment.status) }}</span>
                    <app-progress-steps [steps]="steps(deployment)" [label]="'Steps of deployment ' + (deployment.version.version ?? deployment.version.tag)" />
                    @if (deployment.message) {
                      <p class="cell-note">{{ deployment.message }}</p>
                    }
                  </td>
                  <td>
                    {{ deployment.createdAt | date: 'medium' }}
                    @if (deployment.requestedBy?.displayName; as name) {
                      <p class="cell-note">by {{ name }}</p>
                    }
                  </td>
                  <td class="cell-actions">
                    @for (action of actions(deployment); track action) {
                      <button
                        type="button"
                        class="button"
                        [class.button-danger]="action === 'abort' || action === 'reject'"
                        [attr.aria-label]="actionLabel(action) + ' ' + (deployment.version.version ?? deployment.version.tag) + ' in ' + deployment.environment.name"
                        [disabled]="working()"
                        (click)="act(deployment, action)"
                      >
                        {{ actionLabel(action) }}
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class DeploymentsPanel implements OnInit, OnDestroy {
  /** Shows this application's deployments, and lets people deploy it. */
  readonly application = input<string>();
  /** Shows this environment's deployments. */
  readonly environment = input<string>();
  /** The application's versions. Without them there's no deploy form. */
  readonly versions = input<readonly Build[]>();

  readonly #delivery = inject(DeliveryApi);
  readonly #environments = inject(EnvironmentsApi);
  readonly #session = inject(SessionService);
  readonly #forms = inject(NonNullableFormBuilder);
  #timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly deployments = signal<Deployment[]>([]);
  protected readonly environments = signal<Environment[]>([]);
  protected readonly loading = signal(true);
  protected readonly working = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly chosenEnvironmentId = signal('');

  protected readonly form = this.#forms.group({
    environment: ['', Validators.required],
    version: ['', Validators.required],
    strategy: this.#forms.control<Strategy>('rolling'),
  });

  /** Environments with a connected target that this person may deploy to. */
  protected readonly deployable = computed(() =>
    this.environments().filter((environment) => environment.target?.status === 'connected' && this.#mayDeploy(environment.kind)),
  );
  protected readonly chosenEnvironment = computed(() => this.deployable().find((environment) => environment.id === this.chosenEnvironmentId()));
  protected readonly acceptedVersions = computed(() => {
    const environment = this.chosenEnvironment();
    return (this.versions() ?? []).filter((version) => environment?.acceptedImages.includes(version.kind) ?? false);
  });

  constructor() {
    this.form.controls.environment.valueChanges.subscribe((id) => {
      this.chosenEnvironmentId.set(id);
      this.form.controls.version.setValue(this.acceptedVersions()[0]?.id ?? '');
    });
  }

  async ngOnInit(): Promise<void> {
    await this.#attempt(async () => {
      if (this.versions() !== undefined) {
        this.environments.set(await this.#environments.list('active'));
        this.form.controls.environment.setValue(this.deployable()[0]?.id ?? '');
      }
      await this.#refresh();
    });
    this.loading.set(false);
  }

  ngOnDestroy(): void {
    clearTimeout(this.#timer);
  }

  protected steps(deployment: Deployment): Step[] {
    return deploymentSteps(deployment);
  }

  protected statusLabel(status: DeploymentStatus): string {
    return STATUS_LABELS[status];
  }

  protected statusStyle(status: DeploymentStatus): string | null {
    return status === 'succeeded' ? 'active' : status === 'failed' || status === 'rejected' ? 'provisioning-failed' : null;
  }

  protected strategyLabel(strategy: Strategy): string {
    return STRATEGY_LABELS[strategy];
  }

  protected actionLabel(action: DeploymentAction): string {
    return ACTION_LABELS[action];
  }

  /** What this person can do now. The platform checks again. */
  protected actions(deployment: Deployment): DeploymentAction[] {
    this.#session.user();
    if (!this.#mayDeploy(deployment.environment.kind)) {
      return [];
    }
    switch (deployment.status) {
      case 'awaiting-approval':
        return deployment.requestedBy?.userId === this.#session.user()?.userId ? [] : ['approve', 'reject'];
      case 'paused':
        return ['promote', 'abort'];
      case 'progressing':
        return deployment.strategy === 'recreate' ? [] : ['abort'];
      case 'succeeded':
      case 'failed':
      case 'aborted':
        return this.#latestFinished(deployment) ? ['rollback'] : [];
      default:
        return [];
    }
  }

  protected async deploy(): Promise<void> {
    const application = this.application();
    if (application === undefined) {
      return;
    }
    const { environment, version, strategy } = this.form.getRawValue();
    await this.#attempt(async () => {
      const deployment = await this.#delivery.deploy(application, { environment, version, strategy });
      this.notice.set(
        deployment.status === 'awaiting-approval'
          ? `The deployment to ${deployment.environment.name} waits for someone to approve it.`
          : `Deploying to ${deployment.environment.name}. You can follow each step below.`,
      );
      await this.#refresh();
    });
  }

  protected async act(deployment: Deployment, action: DeploymentAction): Promise<void> {
    await this.#attempt(async () => {
      await this.#delivery.act(deployment.id, action);
      this.notice.set(
        {
          approve: 'Approved. The deployment starts now.',
          reject: 'Rejected.',
          promote: 'Switching traffic to the new version.',
          abort: 'Aborting. Traffic goes back to the previous version.',
          rollback: 'Rolling back to the version that ran before.',
        }[action],
      );
      await this.#refresh();
    });
  }

  #mayDeploy(kind: 'test' | 'production'): boolean {
    this.#session.user();
    return this.#session.can(kind === 'production' ? 'deployments-production:run' : 'deployments-test:run');
  }

  /** Only the newest finished deployment of an application in an environment can be rolled back. */
  #latestFinished(deployment: Deployment): boolean {
    const newest = this.deployments().find(
      (candidate) =>
        candidate.application.id === deployment.application.id &&
        candidate.environment.id === deployment.environment.id &&
        ['succeeded', 'failed', 'aborted'].includes(candidate.status),
    );
    return newest?.id === deployment.id;
  }

  async #refresh(): Promise<void> {
    clearTimeout(this.#timer);
    const filter: { application?: string; environment?: string } = {};
    const application = this.application();
    const environment = this.environment();
    if (application !== undefined) {
      filter.application = application;
    }
    if (environment !== undefined) {
      filter.environment = environment;
    }
    const deployments = await this.#delivery.deployments(filter);
    this.deployments.set(deployments);
    if (deployments.some((deployment) => ACTIVE.includes(deployment.status))) {
      this.#timer = setTimeout(() => void this.#attempt(() => this.#refresh(), { quiet: true }), REFRESH_MS);
    }
  }

  async #attempt(work: () => Promise<void>, options: { quiet?: boolean } = {}): Promise<void> {
    if (!options.quiet) {
      this.error.set(null);
      this.working.set(true);
    }
    try {
      await work();
    } catch (error) {
      this.notice.set(null);
      this.error.set(errorMessage(error));
    } finally {
      if (!options.quiet) {
        this.working.set(false);
      }
    }
  }
}
