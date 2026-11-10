import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api-error';
import { SessionService } from '../../core/session.service';
import { type Application, CatalogApi } from '../catalog/catalog.api';
import { DeploymentsPanel } from '../delivery/deployments-panel';
import { type Environment, type EnvironmentConfig, EnvironmentsApi } from './environments.api';

const NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,99}$/;

/**
 * One environment: its target, its variables and secrets, and what's deployed there.
 * Values can be set for every application, or for one, which then replaces the shared
 * value. Secret values are never shown: they can be replaced or removed.
 */
@Component({
  selector: 'app-environment-detail',
  imports: [DatePipe, DeploymentsPanel, ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p><a routerLink="/environments">← Environments</a></p>
    @if (environment(); as current) {
      <h1>{{ current.name }}</h1>
      <p class="lead">
        {{ current.kind === 'production' ? 'Production' : 'Test' }} · takes {{ current.acceptedImages.join(', ') }} images ·
        @if (current.target; as target) {
          target {{ target.status === 'connected' ? 'connected' : target.status === 'lost' ? 'not reporting' : 'waiting for its agent' }}
        } @else {
          no target connected
        }
      </p>

      @if (error(); as message) {
        <p class="alert alert-error" role="alert">{{ message }}</p>
      }
      @if (notice(); as message) {
        <p class="alert alert-success" role="status">{{ message }}</p>
      }

      @if (current.kind === 'production' && canManageTargets()) {
        <section class="card" aria-labelledby="approval-heading">
          <h2 id="approval-heading">Approval</h2>
          <label class="field-inline">
            <input type="checkbox" [checked]="current.requiresApproval" [disabled]="working()" (change)="setApproval($any($event.target).checked)" />
            <span>A second person approves each deployment</span>
          </label>
          <p class="cell-note">Tech Leads and Operators approve, but never their own deployment. Rollbacks don't wait.</p>
        </section>
      }

      <section class="card" aria-labelledby="config-heading">
        <h2 id="config-heading">Variables and secrets</h2>
        <label class="field">
          <span>For</span>
          <select [value]="scope()" (change)="choose($any($event.target).value)">
            <option value="">Every application</option>
            @for (application of applications(); track application.id) {
              <option [value]="application.id">{{ application.name }} only</option>
            }
          </select>
        </label>
        <p class="cell-note">
          {{ scope() ? "This application's values replace the shared ones of the same name." : 'Every application here gets these.' }}
          Changes apply at the next deployment.
        </p>

        <h3>Variables</h3>
        @if (config().variables.length === 0) {
          <p class="muted">No variables.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Value</th>
                  @if (canManage()) {
                    <th scope="col"><span class="visually-hidden">Actions</span></th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (variable of config().variables; track variable.name + variable.scope) {
                  <tr>
                    <td>
                      <code>{{ variable.name }}</code>
                      @if (scope() && variable.scope === 'environment') {
                        <p class="cell-note">Shared</p>
                      }
                    </td>
                    <td><code>{{ variable.value }}</code></td>
                    @if (canManage()) {
                      <td class="cell-actions">
                        @if (inScope(variable.scope)) {
                          <button type="button" class="button" [attr.aria-label]="'Remove the variable ' + variable.name" [disabled]="working()" (click)="remove('variables', variable.name)">
                            Remove
                          </button>
                        }
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        @if (canManage()) {
          <form class="form-row" [formGroup]="variableForm" (ngSubmit)="save('variables')">
            <label class="field">
              <span>Variable name</span>
              <input type="text" formControlName="name" autocomplete="off" placeholder="LOG_LEVEL" />
            </label>
            <label class="field">
              <span>Value</span>
              <input type="text" formControlName="value" autocomplete="off" maxlength="4096" />
            </label>
            <button type="submit" class="button button-primary" [disabled]="variableForm.invalid || working()">Save variable</button>
          </form>
        }

        <h3>Secrets</h3>
        @if (config().secrets.length === 0) {
          <p class="muted">No secrets.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Last set</th>
                  @if (canManage()) {
                    <th scope="col"><span class="visually-hidden">Actions</span></th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (secret of config().secrets; track secret.name + secret.scope) {
                  <tr>
                    <td>
                      <code>{{ secret.name }}</code>
                      @if (scope() && secret.scope === 'environment') {
                        <p class="cell-note">Shared</p>
                      }
                    </td>
                    <td>{{ secret.updatedAt | date: 'medium' }}</td>
                    @if (canManage()) {
                      <td class="cell-actions">
                        @if (inScope(secret.scope)) {
                          <button type="button" class="button" [attr.aria-label]="'Remove the secret ' + secret.name" [disabled]="working()" (click)="remove('secrets', secret.name)">
                            Remove
                          </button>
                        }
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        @if (canManage()) {
          <form class="form-row" [formGroup]="secretForm" (ngSubmit)="save('secrets')">
            <label class="field">
              <span>Secret name</span>
              <input type="text" formControlName="name" autocomplete="off" placeholder="DATABASE_URL" />
            </label>
            <label class="field">
              <span>Secret value</span>
              <input type="password" formControlName="value" autocomplete="new-password" />
            </label>
            <button type="submit" class="button button-primary" [disabled]="secretForm.invalid || working()">Save secret</button>
          </form>
          <p class="cell-note">Saving a name that exists replaces its value. Nobody can read a secret back here.</p>
        } @else {
          <p class="cell-note">
            {{ current.kind === 'production' ? 'Tech Leads and Operators manage these.' : 'Tech Leads, Operators and Company Admins manage these.' }}
          </p>
        }
      </section>

      <app-deployments-panel [environment]="current.id" />
    } @else if (!error()) {
      <p class="muted">Loading…</p>
    } @else {
      <p class="alert alert-error" role="alert">{{ error() }}</p>
    }
  `,
})
export class EnvironmentDetail implements OnInit {
  /** From the route. */
  readonly id = input.required<string>();

  readonly #api = inject(EnvironmentsApi);
  readonly #catalog = inject(CatalogApi);
  readonly #session = inject(SessionService);
  readonly #forms = inject(NonNullableFormBuilder);

  protected readonly environment = signal<Environment | null>(null);
  protected readonly applications = signal<Application[]>([]);
  protected readonly config = signal<EnvironmentConfig>({ variables: [], secrets: [] });
  /** An application's ID, or empty for every application. */
  protected readonly scope = signal('');
  protected readonly working = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);

  protected readonly canManage = computed(() => {
    this.#session.user();
    return (
      this.#session.can('environment-config:manage') ||
      (this.environment()?.kind === 'test' && this.#session.can('test-environment-config:manage'))
    );
  });
  protected readonly canManageTargets = computed(() => {
    this.#session.user();
    return this.#session.can('targets:connect');
  });

  protected readonly variableForm = this.#forms.group({
    name: ['', [Validators.required, Validators.pattern(NAME_PATTERN)]],
    value: ['', Validators.maxLength(4096)],
  });
  protected readonly secretForm = this.#forms.group({
    name: ['', [Validators.required, Validators.pattern(NAME_PATTERN)]],
    value: ['', Validators.required],
  });

  async ngOnInit(): Promise<void> {
    await this.#attempt(async () => {
      const [environment, applications] = await Promise.all([this.#api.get(this.id()), this.#catalog.list('active')]);
      this.environment.set(environment);
      this.applications.set(applications);
      await this.#loadConfig();
    });
  }

  /** Values of the chosen scope can be removed here; shared ones from "Every application". */
  protected inScope(scope: 'environment' | 'application'): boolean {
    return this.scope() === '' ? scope === 'environment' : scope === 'application';
  }

  protected async choose(scope: string): Promise<void> {
    this.scope.set(scope);
    this.notice.set(null);
    await this.#attempt(() => this.#loadConfig());
  }

  protected async setApproval(required: boolean): Promise<void> {
    await this.#attempt(async () => {
      await this.#api.update(this.id(), { requiresApproval: required });
      this.environment.set(await this.#api.get(this.id()));
      this.notice.set(required ? 'Each deployment now needs a second person to approve it.' : 'Deployments no longer need approval.');
    });
  }

  protected async save(kind: 'variables' | 'secrets'): Promise<void> {
    const form = kind === 'variables' ? this.variableForm : this.secretForm;
    const { name, value } = form.getRawValue();
    await this.#attempt(async () => {
      await this.#api.setValue(this.id(), kind, name, value, this.scope() || undefined);
      form.reset({ name: '', value: '' });
      this.notice.set(`${name} is saved. It applies at the next deployment.`);
      await this.#loadConfig();
    });
  }

  protected async remove(kind: 'variables' | 'secrets', name: string): Promise<void> {
    await this.#attempt(async () => {
      await this.#api.removeValue(this.id(), kind, name, this.scope() || undefined);
      this.notice.set(`${name} is removed. It goes at the next deployment.`);
      await this.#loadConfig();
    });
  }

  async #loadConfig(): Promise<void> {
    this.config.set(await this.#api.config(this.id(), this.scope() || undefined));
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
