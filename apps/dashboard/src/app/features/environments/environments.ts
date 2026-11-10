import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, type OnDestroy, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api-error';
import { SessionService } from '../../core/session.service';
import {
  type Connection,
  type Environment,
  type EnvironmentKind,
  EnvironmentsApi,
  type EnvironmentStatus,
  type TargetStatus,
} from './environments.api';

/** How often the list refreshes while a target is being connected. */
const REFRESH_MS = 5_000;

const TARGET_LABELS: Readonly<Record<TargetStatus, string>> = {
  pending: 'Waiting for the agent',
  connected: 'Connected',
  lost: 'Not reporting',
};

const IMAGE_LABELS: Readonly<Record<string, string>> = { feature: 'feature', rc: 'RC', final: 'final' };

type Editing = { readonly id: string; readonly kind: 'edit' | 'archive' | 'disconnect' } | null;

/**
 * The company's environments and the targets that run them. Every member can see them;
 * Company Admins and Operators create environments and connect targets.
 */
@Component({
  selector: 'app-environments',
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Environments</h1>
    <p class="lead">Where your applications run. Each environment runs on one Kubernetes cluster, its target.</p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }
    @if (notice(); as message) {
      <p class="alert alert-success" role="status">{{ message }}</p>
    }

    @if (connection(); as current) {
      <section class="alert alert-success" role="status" aria-labelledby="connect-heading">
        <h2 id="connect-heading">Connect the target of {{ current.environmentName }}</h2>
        <p>
          Run this command with access to the cluster. It installs the agent, which only makes outbound calls,
          so the cluster needs no open port.
        </p>
        <p>
          The command is shown only once. Its token works once and expires at
          {{ current.connection.expiresAt | date: 'shortTime' }}.
        </p>
        <div class="copy-row">
          <textarea readonly rows="4" aria-label="Connect command" [value]="current.connection.command"></textarea>
          <button type="button" class="button" (click)="copy(current.connection.command)">
            {{ copied() ? 'Copied' : 'Copy' }}
          </button>
        </div>
      </section>
    }

    @if (canManage()) {
      <section class="card" aria-labelledby="create-heading">
        <h2 id="create-heading">Create an environment</h2>
        <form class="form-row" [formGroup]="createForm" (ngSubmit)="create()">
          <label class="field">
            <span>Name</span>
            <input type="text" formControlName="name" maxlength="40" autocomplete="off" required />
          </label>
          <label class="field">
            <span>Kind</span>
            <select formControlName="kind">
              <option value="test">Test</option>
              <option value="production">Production</option>
            </select>
          </label>
          @if (createForm.controls.kind.value === 'test') {
            <label class="field-inline">
              <input type="checkbox" formControlName="acceptsFeatureImages" />
              <span>Accepts feature images</span>
            </label>
          }
          <button type="submit" class="button button-primary" [disabled]="createForm.invalid || working()">
            Create environment
          </button>
        </form>
        <p class="cell-note">
          Production takes final images only. Test environments take RC and final images, and feature images
          unless you turn them off, such as for the environment where you test release candidates. The kind
          can't be changed later.
        </p>
      </section>
    }

    <section class="card" aria-labelledby="list-heading">
      <h2 id="list-heading">{{ status() === 'active' ? 'Environments' : 'Archived environments' }}</h2>
      <div class="form-row" role="group" aria-label="Which environments to show">
        <button type="button" class="button" [attr.aria-pressed]="status() === 'active'" (click)="show('active')">
          Active
        </button>
        <button type="button" class="button" [attr.aria-pressed]="status() === 'archived'" (click)="show('archived')">
          Archived
        </button>
      </div>

      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else if (environments().length === 0) {
        <p class="muted">{{ status() === 'active' ? 'No environments yet.' : 'No archived environments.' }}</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Kind</th>
                <th scope="col">Accepts</th>
                <th scope="col">Target</th>
                @if (canManage()) {
                  <th scope="col"><span class="visually-hidden">Actions</span></th>
                }
              </tr>
            </thead>
            <tbody>
              @for (environment of environments(); track environment.id) {
                <tr>
                  <td>
                    <a [routerLink]="['/environments', environment.id]">{{ environment.name }}</a>
                    <p class="cell-note"><code>{{ environment.slug }}</code></p>
                  </td>
                  <td>{{ environment.kind === 'production' ? 'Production' : 'Test' }}</td>
                  <td>{{ imagesLabel(environment) }} images</td>
                  <td>
                    @if (environment.target; as target) {
                      <span class="status" [attr.data-status]="'target-' + target.status">
                        {{ targetLabel(target.status) }}
                      </span>
                      @if (target.status === 'pending' && target.registrationExpiresAt) {
                        <p class="cell-note">The token expires at {{ target.registrationExpiresAt | date: 'shortTime' }}.</p>
                      } @else {
                        @if (target.lastSeenAt) {
                          <p class="cell-note">Last report {{ target.lastSeenAt | date: 'medium' }}</p>
                        }
                        @if (target.kubernetesVersion) {
                          <p class="cell-note">
                            Kubernetes {{ target.kubernetesVersion }}, agent {{ target.agentVersion ?? 'unknown' }}
                          </p>
                        }
                        @if (target.keyFingerprint) {
                          <p class="cell-note">Key <code>{{ target.keyFingerprint }}</code></p>
                        }
                      }
                    } @else {
                      <span class="muted">Not connected</span>
                    }
                  </td>
                  @if (canManage()) {
                    <td class="cell-actions">
                      @if (environment.status === 'archived') {
                        <button
                          type="button"
                          class="button"
                          [attr.aria-label]="'Restore ' + environment.name"
                          [disabled]="working()"
                          (click)="restore(environment)"
                        >
                          Restore
                        </button>
                      } @else if (isEditing(environment, 'archive')) {
                        <button type="button" class="button button-danger" [disabled]="working()" (click)="archive(environment)">
                          Confirm archiving
                        </button>
                        <button type="button" class="button" (click)="editing.set(null)">Cancel</button>
                      } @else if (isEditing(environment, 'disconnect')) {
                        <button
                          type="button"
                          class="button button-danger"
                          [disabled]="working()"
                          (click)="disconnect(environment)"
                        >
                          Confirm disconnecting
                        </button>
                        <button type="button" class="button" (click)="editing.set(null)">Cancel</button>
                      } @else {
                        @if (environment.target === null || environment.target.status === 'pending') {
                          <button
                            type="button"
                            class="button"
                            [attr.aria-label]="(environment.target ? 'New command for ' : 'Connect a target to ') + environment.name"
                            [disabled]="working()"
                            (click)="connect(environment)"
                          >
                            {{ environment.target ? 'New command' : 'Connect a target' }}
                          </button>
                        }
                        @if (environment.target !== null) {
                          <button
                            type="button"
                            class="button"
                            [attr.aria-label]="'Disconnect the target of ' + environment.name"
                            (click)="editing.set({ id: environment.id, kind: 'disconnect' })"
                          >
                            Disconnect
                          </button>
                        }
                        <button
                          type="button"
                          class="button"
                          [attr.aria-label]="'Edit ' + environment.name"
                          (click)="startEdit(environment)"
                        >
                          Edit
                        </button>
                        @if (environment.target === null) {
                          <button
                            type="button"
                            class="button"
                            [attr.aria-label]="'Archive ' + environment.name"
                            (click)="editing.set({ id: environment.id, kind: 'archive' })"
                          >
                            Archive
                          </button>
                        }
                      }
                    </td>
                  }
                </tr>
                @if (isEditing(environment, 'disconnect')) {
                  <tr>
                    <td colspan="5">
                      <p class="cell-note">
                        The agent's key and tokens stop working at once. Applications already running keep
                        running, but nothing new can be deployed until a target connects again.
                      </p>
                    </td>
                  </tr>
                }
                @if (isEditing(environment, 'edit')) {
                  <tr>
                    <td colspan="5">
                      <form class="form-row" [formGroup]="editForm" (ngSubmit)="save(environment)">
                        <label class="field">
                          <span>Name of {{ environment.name }}</span>
                          <input type="text" formControlName="name" maxlength="40" autocomplete="off" required />
                        </label>
                        @if (environment.kind === 'test') {
                          <label class="field-inline">
                            <input type="checkbox" formControlName="acceptsFeatureImages" />
                            <span>Accepts feature images</span>
                          </label>
                        }
                        <button type="submit" class="button button-primary" [disabled]="editForm.invalid || working()">
                          Save
                        </button>
                        <button type="button" class="button" (click)="editing.set(null)">Cancel</button>
                      </form>
                      <p class="cell-note">The kind and the short name stay the same.</p>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class Environments implements OnInit, OnDestroy {
  readonly #api = inject(EnvironmentsApi);
  readonly #forms = inject(NonNullableFormBuilder);
  readonly #session = inject(SessionService);
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly environments = signal<Environment[]>([]);
  protected readonly status = signal<EnvironmentStatus>('active');
  protected readonly loading = signal(true);
  protected readonly working = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly editing = signal<Editing>(null);
  protected readonly connection = signal<{ environmentName: string; connection: Connection } | null>(null);
  protected readonly copied = signal(false);
  protected readonly canManage = computed(() => {
    this.#session.user();
    return this.#session.can('targets:connect');
  });

  protected readonly createForm = this.#forms.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(40)]],
    kind: this.#forms.control<EnvironmentKind>('test'),
    acceptsFeatureImages: [true],
  });
  protected readonly editForm = this.#forms.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(40)]],
    acceptsFeatureImages: [true],
  });

  async ngOnInit(): Promise<void> {
    await this.#attempt(() => this.#refresh());
    this.loading.set(false);
  }

  ngOnDestroy(): void {
    clearTimeout(this.#refreshTimer);
  }

  protected targetLabel(status: TargetStatus): string {
    return TARGET_LABELS[status];
  }

  protected imagesLabel(environment: Environment): string {
    return sentence(environment.acceptedImages.map((kind) => IMAGE_LABELS[kind] ?? kind));
  }

  protected isEditing(environment: Environment, kind: NonNullable<Editing>['kind']): boolean {
    const editing = this.editing();
    return editing?.id === environment.id && editing.kind === kind;
  }

  protected async show(status: EnvironmentStatus): Promise<void> {
    this.status.set(status);
    this.editing.set(null);
    this.notice.set(null);
    await this.#attempt(() => this.#refresh());
  }

  protected startEdit(environment: Environment): void {
    this.editForm.setValue({ name: environment.name, acceptsFeatureImages: environment.acceptsFeatureImages });
    this.editing.set({ id: environment.id, kind: 'edit' });
  }

  protected async create(): Promise<void> {
    const { name, kind, acceptsFeatureImages } = this.createForm.getRawValue();
    await this.#attempt(async () => {
      const environment = await this.#api.create({
        name,
        kind,
        acceptsFeatureImages: kind === 'test' && acceptsFeatureImages,
      });
      this.createForm.reset({ name: '', kind: 'test', acceptsFeatureImages: true });
      this.notice.set(`${environment.name} is created. Connect a target to deploy to it.`);
      this.status.set('active');
      await this.#refresh();
    });
  }

  protected async save(environment: Environment): Promise<void> {
    const { name, acceptsFeatureImages } = this.editForm.getRawValue();
    await this.#attempt(async () => {
      await this.#api.update(environment.id, {
        name,
        ...(environment.kind === 'test' && { acceptsFeatureImages }),
      });
      this.editing.set(null);
      await this.#refresh();
    });
  }

  protected async connect(environment: Environment): Promise<void> {
    await this.#attempt(async () => {
      const connection = await this.#api.connect(environment.id);
      this.copied.set(false);
      this.connection.set({ environmentName: environment.name, connection });
      this.notice.set(null);
      await this.#refresh();
    });
  }

  protected async disconnect(environment: Environment): Promise<void> {
    await this.#attempt(async () => {
      await this.#api.disconnect(environment.id);
      this.editing.set(null);
      if (this.connection()?.environmentName === environment.name) {
        this.connection.set(null);
      }
      this.notice.set(`The target of ${environment.name} is disconnected.`);
      await this.#refresh();
    });
  }

  protected async archive(environment: Environment): Promise<void> {
    await this.#attempt(async () => {
      await this.#api.archive(environment.id);
      this.editing.set(null);
      this.notice.set(`${environment.name} is archived. You can restore it from the archived list.`);
      await this.#refresh();
    });
  }

  protected async restore(environment: Environment): Promise<void> {
    await this.#attempt(async () => {
      await this.#api.restore(environment.id);
      this.notice.set(`${environment.name} is restored.`);
      await this.#refresh();
    });
  }

  protected async copy(command: string): Promise<void> {
    await navigator.clipboard.writeText(command);
    this.copied.set(true);
  }

  /** Reloads the list, and keeps reloading while a target is being connected. */
  async #refresh(): Promise<void> {
    clearTimeout(this.#refreshTimer);
    const environments = await this.#api.list(this.status());
    this.environments.set(environments);
    const connected = this.connection();
    if (connected !== null) {
      const waited = environments.find((environment) => environment.target?.id === connected.connection.targetId);
      if (waited?.target?.status === 'connected') {
        this.connection.set(null);
        this.notice.set(`The target of ${waited.name} is connected.`);
      }
    }
    if (environments.some((environment) => environment.target?.status === 'pending')) {
      this.#refreshTimer = setTimeout(() => void this.#attempt(() => this.#refresh()), REFRESH_MS);
    }
  }

  async #attempt(work: () => Promise<void>): Promise<void> {
    this.error.set(null);
    this.working.set(true);
    try {
      await work();
    } catch (error) {
      this.notice.set(null);
      this.error.set(errorMessage(error));
    } finally {
      this.working.set(false);
    }
  }
}

function sentence(items: readonly string[]): string {
  const [first, ...rest] = items;
  const text = rest.length === 0 ? first! : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  return `${text[0]!.toUpperCase()}${text.slice(1)}`;
}
