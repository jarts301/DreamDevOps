import { ChangeDetectionStrategy, Component, computed, inject, type OnDestroy, type OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { PageActivity } from '../../core/page-activity';
import { SessionService } from '../../core/session.service';
import { errorMessage } from '../../core/api-error';
import { type Application, CatalogApi } from '../catalog/catalog.api';
import { DeployPanel, type DeployRequest } from './deploy-panel';
import { deploymentKindName, deploymentStatusName, imageKindName } from './deployment-labels';
import { DeploymentHistory } from './deployment-history';
import { EnvironmentVariables } from './environment-variables';
import {
  type Environment,
  EnvironmentsApi,
  type HostingTarget,
  type ProductionConfirmation,
  type RecordStatus,
} from './environments.api';
import { kindName } from './hosting-labels';
import { ProductionConfirmationPanel } from './production-confirmation';

/** What's open on an environment's row. */
type Changes = { name?: string; targetId?: string | null };

type Editing =
  | { readonly id: string; readonly kind: 'edit' | 'protect' | 'unprotect' | 'archive' | 'deploy' | 'stop' }
  | { readonly id: string; readonly kind: 'confirm-edit'; readonly changes: Changes }
  | null;

/** How often the page refreshes while a deployment is queued or under way. */
const REFRESH_MS = 2_000;

/**
 * Each application's environments, where each runs, and which version runs in each.
 * Production ones are protected, and run only releases.
 */
@Component({
  selector: 'app-environments',
  imports: [DeployPanel, DeploymentHistory, EnvironmentVariables, ProductionConfirmationPanel, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Environments</h1>
    <p class="lead">
      Where each application runs, from development to production, and which version runs in each. Production
      environments run only releases, and are protected: changing one needs its name typed exactly and a reason, and
      none can be archived while protected.
    </p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }
    @if (notice(); as message) {
      <p class="alert alert-success" role="status">{{ message }}</p>
    }

    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else if (applications().length === 0) {
      <p class="empty-state">No applications yet. Register one on the Applications page first.</p>
    } @else {
      <section class="card" aria-labelledby="application-heading">
        <h2 id="application-heading" class="visually-hidden">Application</h2>
        <label class="field-inline">
          <span>Application</span>
          <select [value]="selectedId()" (change)="choose($event)">
            @for (application of applications(); track application.id) {
              <option [value]="application.id" [selected]="application.id === selectedId()">{{ application.name }}</option>
            }
          </select>
        </label>
      </section>

      @if (canManage()) {
        <section class="card" aria-labelledby="create-heading">
          <h2 id="create-heading">Add an environment</h2>
          <div class="form-row">
            <label class="field">
              <span>Name</span>
              <input type="text" maxlength="40" autocomplete="off" [value]="newName()" (input)="newName.set(value($event))" />
            </label>
            <label class="field">
              <span>Runs on</span>
              <select (change)="chooseNewTarget($event)">
                <option value="" [selected]="newTarget() === ''">Choose later</option>
                @for (target of targets(); track target.id) {
                  <option [value]="target.id" [selected]="newTarget() === target.id">{{ targetLabel(target) }}</option>
                }
              </select>
            </label>
            @if (canManageProduction()) {
              <label class="checkbox">
                <input type="checkbox" [checked]="newProduction()" (change)="newProduction.set(checked($event))" />
                <span>Production</span>
              </label>
            }
            <button type="button" class="button button-primary" [disabled]="newName().trim().length < 2 || working()" (click)="create()">
              Add environment
            </button>
          </div>
          @if (newProduction()) {
            <p class="cell-note">Production is protected from the start: changing it later needs its name typed and a reason.</p>
          }
          @if (targets().length === 0) {
            <p class="cell-note">No hosting targets yet. <a routerLink="/hosting">Connect one</a> to choose where environments run.</p>
          }
        </section>
      }

      <section class="card" aria-labelledby="list-heading">
        <h2 id="list-heading">{{ status() === 'active' ? 'Environments' : 'Archived environments' }}</h2>
        <div class="form-row" role="group" aria-label="Which environments to show">
          <button type="button" class="button" [attr.aria-pressed]="status() === 'active'" (click)="show('active')">Active</button>
          <button type="button" class="button" [attr.aria-pressed]="status() === 'archived'" (click)="show('archived')">
            Archived
          </button>
        </div>

        @if (environments().length === 0) {
          <p class="muted">{{ status() === 'active' ? 'No environments yet.' : 'No archived environments.' }}</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Environment</th>
                  <th scope="col">Runs on</th>
                  <th scope="col">Version</th>
                  <th scope="col"><span class="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (environment of environments(); track environment.id) {
                  <tr [attr.data-production]="environment.production">
                    <td>
                      {{ environment.name }}
                      @if (environment.production) {
                        <span class="status" data-tone="production">Production, protected</span>
                      }
                      <p class="cell-note"><code>{{ environment.slug }}</code></p>
                    </td>
                    <td>
                      @if (environment.target; as target) {
                        {{ target.name }}
                        <p class="cell-note">
                          {{ target.provider.name === target.name ? '' : target.provider.name + ' · ' }}{{ kindName(target.provider.kind) }}
                        </p>
                      } @else {
                        <span class="muted">Not chosen yet</span>
                      }
                    </td>
                    <td>
                      @if (environment.live; as live) {
                        {{ live.version }}&ngsp;
                        <span class="status" [attr.data-tone]="live.productive ? 'success' : null">{{ imageKindName(live.imageKind) }}</span>
                        @if (live.address) {
                          <p class="cell-note"><a [href]="live.address" target="_blank" rel="noopener">{{ live.address }}</a></p>
                        }
                        @if (environment.target && live.target.id !== environment.target.id) {
                          <p class="cell-note">Still runs on {{ live.target.name }}. Deploy again to move it.</p>
                        }
                        @if (environment.settingsPending) {
                          <p class="cell-note">Variables changed since it started. Deploy it again to apply them.</p>
                        }
                      } @else {
                        <span class="muted">Nothing runs</span>
                      }
                      @if (environment.deploying; as deploying) {
                        <p>
                          <span class="status" data-tone="progress">
                            {{ deploymentKindName(deploying.kind) }} {{ deploying.version }}: {{ deploymentStatusName(deploying.status) }}
                          </span>
                        </p>
                      }
                    </td>
                    <td class="cell-actions cell-actions-wrap">
                      <div class="action-group">
                        <button
                          type="button"
                          class="button"
                          [attr.aria-expanded]="showsHistory(environment)"
                          [attr.aria-label]="(showsHistory(environment) ? 'Hide deployments of ' : 'Show deployments of ') + environment.name"
                          [disabled]="environment.deploying !== null"
                          (click)="toggleHistory(environment)"
                        >
                          {{ showsHistory(environment) ? 'Hide deployments' : 'Deployments' }}
                        </button>
                        <button
                          type="button"
                          class="button"
                          [attr.aria-expanded]="showsVariables(environment)"
                          [attr.aria-label]="(showsVariables(environment) ? 'Hide variables of ' : 'Show variables of ') + environment.name"
                          (click)="toggleVariables(environment)"
                        >
                          {{ showsVariables(environment) ? 'Hide variables' : 'Variables (' + environment.variables + ')' }}
                        </button>
                        @if (environment.status === 'active' && !isOpen(environment) && canDeploy(environment)) {
                          <button
                            type="button"
                            class="button"
                            [attr.aria-label]="'Deploy to ' + environment.name"
                            [disabled]="deployProblem(environment) !== null"
                            [attr.title]="deployProblem(environment)"
                            (click)="open(environment, 'deploy')"
                          >
                            Deploy
                          </button>
                          @if (environment.live) {
                            <button
                              type="button"
                              class="button"
                              [attr.aria-label]="'Stop ' + environment.live.version + ' in ' + environment.name"
                              [disabled]="environment.deploying !== null"
                              (click)="open(environment, 'stop')"
                            >
                              Stop
                            </button>
                          }
                        }
                      </div>
                      @if (canManage()) {
                        <div class="action-group">
                          @if (environment.status === 'archived') {
                            <button type="button" class="button" [attr.aria-label]="'Restore ' + environment.name" [disabled]="working()" (click)="restore(environment)">
                              Restore
                            </button>
                          } @else if (!isOpen(environment)) {
                            @if (!environment.production || canManageProduction()) {
                              <button type="button" class="button" [attr.aria-label]="'Edit ' + environment.name" (click)="open(environment, 'edit')">
                                Edit
                              </button>
                            }
                            @if (canManageProduction()) {
                              <button
                                type="button"
                                class="button"
                                [attr.aria-label]="(environment.production ? 'Remove production protection from ' : 'Make production: ') + environment.name"
                                [disabled]="!environment.production && productionProblem(environment) !== null"
                                [attr.title]="environment.production ? null : productionProblem(environment)"
                                (click)="open(environment, environment.production ? 'unprotect' : 'protect')"
                              >
                                {{ environment.production ? 'Remove protection' : 'Make production' }}
                              </button>
                            }
                            @if (!environment.production) {
                              <button
                                type="button"
                                class="button"
                                [attr.aria-label]="'Archive ' + environment.name"
                                [disabled]="environment.live !== null"
                                [attr.title]="environment.live !== null ? 'Stop what runs in it first' : null"
                                (click)="open(environment, 'archive')"
                              >
                                Archive
                              </button>
                            }
                          }
                        </div>
                      }
                    </td>
                  </tr>
                  @if (isOpen(environment)) {
                    <tr>
                      <td colspan="4">
                        @switch (editing()?.kind) {
                          @case ('deploy') {
                            <app-deploy-panel
                              [environment]="environment"
                              [preselect]="deployPreselect()"
                              [working]="working()"
                              (deploy)="deployTo(environment, $event)"
                              (cancel)="close()"
                            />
                          }
                          @case ('stop') {
                            @if (environment.production) {
                              <app-production-confirmation
                                [name]="environment.name"
                                [what]="'Stop ' + (environment.live?.version ?? 'what runs') + ' in the production environment ' + environment.name"
                                action="Stop it"
                                [working]="working()"
                                (confirm)="stop(environment, $event)"
                                (cancel)="close()"
                              />
                            } @else {
                              <div class="form-row">
                                <p>
                                  Stop {{ environment.live?.version }} in {{ environment.name }}? It's removed from
                                  {{ environment.live?.target?.name }}, and nothing runs there until you deploy again.
                                </p>
                                <button type="button" class="button button-danger" [disabled]="working()" (click)="stop(environment)">
                                  Stop it
                                </button>
                                <button type="button" class="button" (click)="close()">Cancel</button>
                              </div>
                            }
                          }
                          @case ('edit') {
                            <div class="form-row">
                              <label class="field">
                                <span>Name of {{ environment.name }}</span>
                                <input type="text" maxlength="40" autocomplete="off" [value]="editName()" (input)="editName.set(value($event))" />
                              </label>
                              <label class="field">
                                <span>Runs on</span>
                                <select (change)="editTarget.set(value($event))">
                                  <option value="" [selected]="editTarget() === ''">Not chosen yet</option>
                                  @for (target of targets(); track target.id) {
                                    <option [value]="target.id" [selected]="editTarget() === target.id">{{ targetLabel(target) }}</option>
                                  }
                                </select>
                              </label>
                              <button type="button" class="button button-primary" [disabled]="working()" (click)="save(environment)">Save</button>
                              <button type="button" class="button" (click)="close()">Cancel</button>
                            </div>
                            <p class="cell-note">The short name, {{ environment.slug }}, stays the same.</p>
                            @if (environment.live; as live) {
                              <p class="cell-note">
                                {{ live.version }} runs in it. Choosing another target deploys it there, then removes it from
                                {{ live.target.name }}.
                              </p>
                            }
                          }
                          @case ('confirm-edit') {
                            <app-production-confirmation
                              [name]="environment.name"
                              [what]="'Change the production environment ' + environment.name"
                              action="Save the change"
                              [working]="working()"
                              (confirm)="saveConfirmed(environment, $event)"
                              (cancel)="close()"
                            />
                          }
                          @case ('unprotect') {
                            <app-production-confirmation
                              [name]="environment.name"
                              [what]="'Remove production protection from ' + environment.name"
                              action="Remove protection"
                              [working]="working()"
                              (confirm)="unprotect(environment, $event)"
                              (cancel)="close()"
                            />
                          }
                          @case ('protect') {
                            <p>
                              Make <strong>{{ environment.name }}</strong> production? From then on, changing it needs its name
                              typed and a reason, and it can't be archived.
                            </p>
                            <div class="form-row">
                              <label class="field field-wide">
                                <span>Why (optional, kept in the audit log)</span>
                                <textarea rows="2" maxlength="500" [value]="reason()" (input)="reason.set(value($event))"></textarea>
                              </label>
                              <button type="button" class="button button-primary" [disabled]="working()" (click)="protect(environment)">
                                Make production
                              </button>
                              <button type="button" class="button" (click)="close()">Cancel</button>
                            </div>
                          }
                          @case ('archive') {
                            <div class="form-row">
                              <p>Archive {{ environment.name }}? Nothing is deleted, and you can restore it.</p>
                              <button type="button" class="button button-danger" [disabled]="working()" (click)="archive(environment)">
                                Confirm archiving
                              </button>
                              <button type="button" class="button" (click)="close()">Cancel</button>
                            </div>
                          }
                        }
                      </td>
                    </tr>
                  }
                  @if (showsVariables(environment)) {
                    <tr class="history-row">
                      <td colspan="4">
                        <app-environment-variables
                          [environment]="environment"
                          [canManage]="canManageVariables(environment)"
                          [canDeploy]="canDeploy(environment) && deployProblem(environment) === null"
                          (changed)="reload()"
                          (apply)="applySettings(environment)"
                        />
                      </td>
                    </tr>
                  }
                  @if (showsHistory(environment)) {
                    <tr class="history-row">
                      <td colspan="4">
                        <app-deployment-history
                          [environmentId]="environment.id"
                          [environmentName]="environment.name"
                          [refresh]="refreshKey(environment)"
                        />
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
          @if (hasProduction() && canManage() && status() === 'active') {
            <p class="cell-note">Production environments can't be archived. Remove their protection first.</p>
          }
        }
      </section>
    }
  `,
})
export class Environments implements OnInit, OnDestroy {
  readonly #api = inject(EnvironmentsApi);
  readonly #catalog = inject(CatalogApi);
  readonly #session = inject(SessionService);
  readonly #route = inject(ActivatedRoute);
  readonly #router = inject(Router);
  readonly #activity = new PageActivity('clear-on-failure');
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #destroyed = false;
  #pollFailed = false;
  /** Whether the person chose where a new environment runs, so loading doesn't change it. */
  #newTargetChosen = false;

  protected readonly working = this.#activity.working;
  protected readonly error = this.#activity.error;
  protected readonly notice = this.#activity.notice;
  protected readonly kindName = kindName;
  protected readonly imageKindName = imageKindName;
  protected readonly deploymentKindName = deploymentKindName;
  protected readonly deploymentStatusName = deploymentStatusName;
  /** Environments whose deployments are shown. Ones under way show anyway. */
  protected readonly historyOpen = signal<ReadonlySet<string>>(new Set());
  /** Environments whose variables are shown. */
  protected readonly variablesOpen = signal<ReadonlySet<string>>(new Set());
  /** The version the deploy panel starts with, when deploying again to apply changed variables. */
  protected readonly deployPreselect = signal<string | null>(null);
  /** Counts refreshes while deployments are under way, so their steps load again. */
  protected readonly tick = signal(0);

  protected readonly applications = signal<Application[]>([]);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly status = signal<RecordStatus>('active');
  protected readonly environments = signal<Environment[]>([]);
  protected readonly targets = signal<HostingTarget[]>([]);
  protected readonly loading = signal(true);
  protected readonly editing = signal<Editing>(null);

  protected readonly newName = signal('');
  protected readonly newTarget = signal('');
  protected readonly newProduction = signal(false);
  protected readonly editName = signal('');
  protected readonly editTarget = signal('');
  protected readonly reason = signal('');

  protected readonly canManage = computed(() => {
    this.#session.user();
    return this.#session.can('environments:manage');
  });
  protected readonly canManageProduction = computed(() => {
    this.#session.user();
    return this.#session.can('environments-production:manage');
  });
  protected readonly hasProduction = computed(() => this.environments().some((environment) => environment.production));

  async ngOnInit(): Promise<void> {
    await this.#activity.run(async () => {
      const [applications, targets] = await Promise.all([this.#catalog.list('active'), this.#api.targets('active')]);
      this.applications.set(applications);
      this.targets.set(targets);
      const requested = this.#route.snapshot.queryParamMap.get('application');
      this.selectedId.set(applications.find((application) => application.id === requested)?.id ?? applications[0]?.id ?? null);
      await this.#load();
    });
    this.loading.set(false);
  }

  ngOnDestroy(): void {
    this.#destroyed = true;
    clearTimeout(this.#refreshTimer);
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected targetLabel(target: HostingTarget): string {
    return target.name === target.provider.name ? target.name : `${target.name} (${target.provider.name})`;
  }

  protected chooseNewTarget(event: Event): void {
    this.#newTargetChosen = true;
    this.newTarget.set(this.value(event));
  }

  /** Deploying to production needs more than deploying elsewhere. */
  protected canDeploy(environment: Environment): boolean {
    this.#session.user();
    return this.#session.can(environment.production ? 'deployments-production:run' : 'deployments-test:run');
  }

  /** Why the environment can't be deployed to now, or null. */
  protected deployProblem(environment: Environment): string | null {
    if (environment.deploying !== null) {
      return 'A deployment is under way';
    }
    if (environment.target === null) {
      return 'Choose where it runs first';
    }
    if (!environment.target.provider.deploys) {
      return `DreamDevOps can't deploy to ${environment.target.provider.name} targets yet`;
    }
    return null;
  }

  /** Why the environment can't become production now, or null. Production runs only releases. */
  protected productionProblem(environment: Environment): string | null {
    if (environment.deploying !== null) {
      return 'A deployment is under way';
    }
    if (environment.live !== null && !environment.live.productive) {
      return `It runs ${environment.live.version}, which isn't a release. Deploy a release to it, or stop it, first.`;
    }
    return null;
  }

  protected showsVariables(environment: Environment): boolean {
    return this.variablesOpen().has(environment.id);
  }

  protected toggleVariables(environment: Environment): void {
    const next = new Set(this.variablesOpen());
    if (!next.delete(environment.id)) {
      next.add(environment.id);
    }
    this.variablesOpen.set(next);
  }

  /** Production's variables need the permission to manage production as well. */
  protected canManageVariables(environment: Environment): boolean {
    return this.canManage() && (!environment.production || this.canManageProduction());
  }

  /** Opens the deploy panel with the version that runs, so deploying it again applies changed variables. */
  protected applySettings(environment: Environment): void {
    this.open(environment, 'deploy');
    this.deployPreselect.set(environment.live?.buildId ?? null);
  }

  /** Reloads quietly after a change elsewhere on the page, such as to variables. */
  protected async reload(): Promise<void> {
    try {
      await this.#load();
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  protected showsHistory(environment: Environment): boolean {
    return environment.deploying !== null || this.historyOpen().has(environment.id);
  }

  protected toggleHistory(environment: Environment): void {
    const next = new Set(this.historyOpen());
    if (!next.delete(environment.id)) {
      next.add(environment.id);
    }
    this.historyOpen.set(next);
  }

  /** Changes whenever the environment's deployments may have, so its history loads again. */
  protected refreshKey(environment: Environment): string {
    const deploying = environment.deploying;
    return [deploying?.id ?? '', deploying?.status ?? '', environment.live?.deploymentId ?? '', deploying ? this.tick() : ''].join('|');
  }

  protected async choose(event: Event): Promise<void> {
    this.selectedId.set(this.value(event));
    this.close();
    this.notice.set(null);
    await this.#router.navigate([], { queryParams: { application: this.selectedId() }, replaceUrl: true });
    await this.#activity.run(() => this.#load());
  }

  protected async show(status: RecordStatus): Promise<void> {
    this.status.set(status);
    this.close();
    this.notice.set(null);
    await this.#activity.run(() => this.#load());
  }

  protected isOpen(environment: Environment): boolean {
    return this.editing()?.id === environment.id;
  }

  protected open(environment: Environment, kind: 'edit' | 'protect' | 'unprotect' | 'archive' | 'deploy' | 'stop'): void {
    this.editName.set(environment.name);
    this.editTarget.set(environment.target?.id ?? '');
    this.reason.set('');
    this.deployPreselect.set(null);
    this.editing.set({ id: environment.id, kind });
  }

  protected close(): void {
    this.editing.set(null);
  }

  protected async deployTo(environment: Environment, request: DeployRequest): Promise<void> {
    await this.#act(async () => {
      await this.#api.deploy(environment, request.buildId, {
        ...(request.confirmation !== undefined && { confirmation: request.confirmation }),
        ...(request.reason !== undefined && { reason: request.reason }),
      });
      return `${request.version} is being deployed to ${environment.name}. Follow its steps below.`;
    });
  }

  protected async stop(environment: Environment, confirmation?: ProductionConfirmation): Promise<void> {
    await this.#act(async () => {
      await this.#api.stop(environment, confirmation);
      return `${environment.live?.version ?? 'What runs'} is being stopped in ${environment.name}.`;
    });
  }

  protected async create(): Promise<void> {
    const applicationId = this.selectedId();
    if (applicationId === null) {
      return;
    }
    await this.#act(async () => {
      const environment = await this.#api.create(applicationId, {
        name: this.newName().trim(),
        production: this.newProduction(),
        targetId: this.newTarget() === '' ? null : this.newTarget(),
      });
      this.newName.set('');
      this.newProduction.set(false);
      this.status.set('active');
      return `${environment.name} is added${environment.production ? ' as a protected production environment' : ''}.`;
    });
  }

  /** Non-production changes are saved at once. Production first asks for its name and a reason. */
  protected async save(environment: Environment): Promise<void> {
    // Only what changed is sent, so an unchanged field is never checked again.
    const name = this.editName().trim();
    const targetId = this.editTarget() === '' ? null : this.editTarget();
    const changes: Changes = {
      ...(name !== environment.name && { name }),
      ...(targetId !== (environment.target?.id ?? null) && { targetId }),
    };
    if (Object.keys(changes).length === 0) {
      this.close();
      return;
    }
    if (environment.production) {
      this.editing.set({ id: environment.id, kind: 'confirm-edit', changes });
      return;
    }
    await this.#act(async () => {
      const saved = await this.#api.update(environment, changes);
      return savedMessage(saved);
    });
  }

  protected async saveConfirmed(environment: Environment, confirmation: ProductionConfirmation): Promise<void> {
    const editing = this.editing();
    if (editing?.kind !== 'confirm-edit') {
      return;
    }
    await this.#act(async () => {
      const saved = await this.#api.update(environment, editing.changes, confirmation);
      return `${savedMessage(saved)} The reason is in the audit log.`;
    });
  }

  protected async protect(environment: Environment): Promise<void> {
    const reason = this.reason().trim();
    await this.#act(async () => {
      await this.#api.act(environment, 'protect', reason === '' ? {} : { reason });
      return `${environment.name} is now a protected production environment.`;
    });
  }

  protected async unprotect(environment: Environment, confirmation: ProductionConfirmation): Promise<void> {
    await this.#act(async () => {
      await this.#api.act(environment, 'unprotect', confirmation);
      return `${environment.name} is no longer production.`;
    });
  }

  protected async archive(environment: Environment): Promise<void> {
    await this.#act(async () => {
      await this.#api.act(environment, 'archive');
      return `${environment.name} is archived. You can restore it from the archived list.`;
    });
  }

  protected async restore(environment: Environment): Promise<void> {
    await this.#act(async () => {
      await this.#api.act(environment, 'restore');
      return `${environment.name} is restored.`;
    });
  }

  /** Runs a change, closing what's open if it succeeds, and reloads either way. */
  async #act(work: () => Promise<string>): Promise<void> {
    await this.#activity.change(async () => {
      const message = await work();
      this.close();
      return message;
    }, () => this.#load());
  }

  async #load(): Promise<void> {
    const applicationId = this.selectedId();
    if (applicationId === null) {
      return;
    }
    const [environments, targets] = await Promise.all([
      this.#api.environments(applicationId, this.status()),
      this.#api.targets('active'),
    ]);
    this.environments.set(environments);
    this.targets.set(targets);
    // New environments run on this machine unless the person chooses otherwise.
    if (!this.#newTargetChosen) {
      this.newTarget.set(targets.find((target) => target.provider.key === 'local')?.id ?? '');
    }
    clearTimeout(this.#refreshTimer);
    const underWay = environments.filter((environment) => environment.deploying !== null);
    if (underWay.length > 0) {
      // Their deployments stay shown once done, so people see how they ended.
      this.historyOpen.set(new Set([...this.historyOpen(), ...underWay.map((environment) => environment.id)]));
      this.#schedule(REFRESH_MS);
    }
  }

  /**
   * While a deployment is under way, the page reloads quietly, so buttons don't flicker.
   * If a refresh fails, it says so and tries again a little later.
   */
  #schedule(delayMs: number): void {
    if (this.#destroyed) {
      return;
    }
    this.#refreshTimer = setTimeout(async () => {
      try {
        this.tick.update((tick) => tick + 1);
        await this.#load();
        if (this.#pollFailed) {
          this.#pollFailed = false;
          this.error.set(null);
        }
      } catch (error) {
        this.#pollFailed = true;
        this.error.set(errorMessage(error));
        this.#schedule(REFRESH_MS * 5);
      }
    }, delayMs);
  }
}

/** What saving says, including a move of what runs, which happens in the background. */
function savedMessage(environment: Environment): string {
  return environment.deploying?.kind === 'move'
    ? `${environment.name} is saved. ${environment.deploying.version} is moving to ${environment.target?.name}. Follow its steps below.`
    : `${environment.name} is saved.`;
}
