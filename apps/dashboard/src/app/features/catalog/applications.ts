import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, type OnDestroy, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { PageActivity } from '../../core/page-activity';
import { SessionService } from '../../core/session.service';
import {
  type Application,
  type ApplicationStatus,
  type ApplicationType,
  CatalogApi,
  type Repository,
  type SourceAccess,
  type TeamKey,
} from './catalog.api';

const TEAMS: Readonly<Record<TeamKey, { label: string; ability: string }>> = {
  'tech-leads': { label: 'Tech Leads', ability: 'push code and approve pull requests' },
  developers: { label: 'Developers', ability: 'push code and open pull requests' },
  readers: { label: 'Readers', ability: 'read the code' },
};

/** How often the list refreshes while a repository is being created. */
const REFRESH_MS = 3_000;
/** How long after registering a missing repository counts as still being created. */
const NEW_APPLICATION_MS = 2 * 60_000;

type Editing = { readonly id: string; readonly kind: 'edit' | 'archive' } | null;

/** The company's applications. Every member can see them, and Tech Leads and Company Admins manage them. */
@Component({
  selector: 'app-applications',
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Applications</h1>
    <p class="lead">Every application your company builds and runs.</p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }
    @if (notice(); as message) {
      <p class="alert alert-success" role="status">{{ message }}</p>
    }

    @if (canManage()) {
      <section class="card" aria-labelledby="register-heading">
        <h2 id="register-heading">Register an application</h2>
        <form class="form-row" [formGroup]="registerForm" (ngSubmit)="register()">
          <label class="field">
            <span>Name</span>
            <input type="text" formControlName="name" maxlength="80" autocomplete="off" required />
          </label>
          <label class="field">
            <span>Type</span>
            <select formControlName="type" required>
              @for (type of types(); track type.key) {
                <option [value]="type.key">{{ type.name }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span>Language</span>
            <select formControlName="language" required>
              @for (language of languages(); track language) {
                <option [value]="language">{{ language }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span>Framework</span>
            <select formControlName="blueprint" required>
              @for (blueprint of frameworks(); track blueprint.key) {
                <option [value]="blueprint.key">{{ blueprint.framework }}</option>
              }
            </select>
          </label>
          <label class="field field-wide">
            <span>Description (optional)</span>
            <textarea formControlName="description" rows="2" maxlength="500"></textarea>
          </label>
          <button type="submit" class="button button-primary" [disabled]="registerForm.invalid || working()">
            Register application
          </button>
        </form>
        @if (chosenType(); as type) {
          <p class="cell-note">{{ type.name }}: {{ type.description }}.</p>
        }
        @if (chosenBlueprint(); as blueprint) {
          <p class="cell-note">
            It starts from the {{ blueprint.name }} blueprint {{ blueprint.version }}, in {{ blueprint.language }} with
            {{ blueprint.framework }}. {{ blueprint.description }}
          </p>
        }
        <p class="cell-note">
          Registering creates a private repository from the blueprint, with Git Flow branches and rules.
        </p>
      </section>
    }

    @if (access(); as current) {
      <section class="card" aria-labelledby="git-heading">
        <h2 id="git-heading">Your Git access</h2>
        @if (current.hasAccount) {
          <p>You're in the {{ teamLabel(current.team) }} team in Forgejo, so you can {{ teamAbility(current.team) }}.</p>
          <a class="button" [href]="current.gitUrl" target="_blank" rel="noopener">Open Forgejo</a>
        } @else {
          <p>
            Sign in to Forgejo once with your DreamDevOps account, then check again here. You'll join the
            {{ teamLabel(current.team) }} team, so you can {{ teamAbility(current.team) }}.
          </p>
          <div class="form-row">
            <a class="button button-primary" [href]="current.signInUrl" target="_blank" rel="noopener">
              Sign in to Forgejo
            </a>
            <button type="button" class="button" [disabled]="working()" (click)="checkAccess()">Check again</button>
          </div>
        }
      </section>
    }

    <section class="card" aria-labelledby="list-heading">
      <h2 id="list-heading">{{ status() === 'active' ? 'Applications' : 'Archived applications' }}</h2>
      <div class="form-row" role="group" aria-label="Which applications to show">
        <button type="button" class="button" [attr.aria-pressed]="status() === 'active'" (click)="show('active')">
          Active
        </button>
        <button type="button" class="button" [attr.aria-pressed]="status() === 'archived'" (click)="show('archived')">
          Archived
        </button>
      </div>

      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else if (applications().length === 0) {
        <p class="muted">{{ status() === 'active' ? 'No applications yet.' : 'No archived applications.' }}</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Short name</th>
                <th scope="col">Repository</th>
                <th scope="col">Registered</th>
                @if (canManage()) {
                  <th scope="col"><span class="visually-hidden">Actions</span></th>
                }
              </tr>
            </thead>
            <tbody>
              @for (application of applications(); track application.id) {
                @let repository = repositories().get(application.id);
                <tr>
                  <td>
                    <a [routerLink]="['/applications', application.id]">{{ application.name }}</a>
                    @if (application.description) {
                      <p class="cell-note">{{ application.description }}</p>
                    }
                    @if (application.status === 'active') {
                      <p class="cell-note">
                        <a
                          routerLink="/environments"
                          [queryParams]="{ application: application.id }"
                          [attr.aria-label]="'Environments of ' + application.name"
                          >Environments</a
                        >
                      </p>
                    }
                  </td>
                  <td>
                    {{ application.type.name }}
                    @if (application.blueprint; as blueprint) {
                      <p class="cell-note">{{ blueprint.framework }} · {{ blueprint.language }}</p>
                    }
                  </td>
                  <td><code>{{ application.slug }}</code></td>
                  <td>
                    @if (repository === undefined && isNew(application)) {
                      <span class="status">Being created…</span>
                    } @else if (repository === undefined) {
                      <span class="muted">Not created</span>
                      @if (canManage() && application.status === 'active') {
                        <p class="cell-note">
                          <button
                            type="button"
                            class="button"
                            [attr.aria-label]="'Create the repository of ' + application.name"
                            [disabled]="working()"
                            (click)="requestRepository(application)"
                          >
                            Create repository
                          </button>
                        </p>
                      }
                    } @else if (repository.status === 'ready') {
                      <a [href]="repository.url" target="_blank" rel="noopener">{{ repository.fullName }}</a>
                      @if (repository.blueprint; as blueprint) {
                        <p class="cell-note">From {{ blueprint.key }} {{ blueprint.version }}</p>
                      }
                      @if (canBuildTestImages() && application.status === 'active') {
                        <p class="cell-note">
                          <a
                            [routerLink]="['/applications', application.id]"
                            [queryParams]="{ build: 'test' }"
                            [attr.aria-label]="'Build a test image of ' + application.name"
                            >Build a test image</a
                          >
                        </p>
                      }
                    } @else if (repository.status === 'creating') {
                      <span class="status">Being created…</span>
                    } @else {
                      <span class="status" data-status="provisioning-failed">Failed</span>
                      <p class="cell-note">{{ repository.lastError }}</p>
                      @if (canManage() && application.status === 'active') {
                        <button
                          type="button"
                          class="button"
                          [attr.aria-label]="'Try creating the repository of ' + application.name + ' again'"
                          [disabled]="working()"
                          (click)="requestRepository(application)"
                        >
                          Try again
                        </button>
                      }
                    }
                  </td>
                  <td>
                    {{ application.createdAt | date: 'mediumDate' }}
                    @if (application.createdBy?.displayName; as creator) {
                      <p class="cell-note">by {{ creator }}</p>
                    }
                  </td>
                  @if (canManage()) {
                    <td class="cell-actions">
                      @if (application.status === 'archived') {
                        <button
                          type="button"
                          class="button"
                          [attr.aria-label]="'Restore ' + application.name"
                          [disabled]="working()"
                          (click)="restore(application)"
                        >
                          Restore
                        </button>
                      } @else if (isEditing(application, 'archive')) {
                        <button type="button" class="button button-danger" [disabled]="working()" (click)="archive(application)">
                          Confirm archiving
                        </button>
                        <button type="button" class="button" (click)="editing.set(null)">Cancel</button>
                      } @else {
                        <button
                          type="button"
                          class="button"
                          [attr.aria-label]="'Edit ' + application.name"
                          (click)="startEdit(application)"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          class="button"
                          [attr.aria-label]="'Archive ' + application.name"
                          (click)="editing.set({ id: application.id, kind: 'archive' })"
                        >
                          Archive
                        </button>
                      }
                    </td>
                  }
                </tr>
                @if (isEditing(application, 'edit')) {
                  <tr>
                    <td colspan="6">
                      <form class="form-row" [formGroup]="editForm" (ngSubmit)="save(application)">
                        <label class="field">
                          <span>Name of {{ application.name }}</span>
                          <input type="text" formControlName="name" maxlength="80" autocomplete="off" required />
                        </label>
                        <label class="field field-wide">
                          <span>Description</span>
                          <textarea formControlName="description" rows="2" maxlength="500"></textarea>
                        </label>
                        <button type="submit" class="button button-primary" [disabled]="editForm.invalid || working()">
                          Save
                        </button>
                        <button type="button" class="button" (click)="editing.set(null)">Cancel</button>
                      </form>
                      <p class="cell-note">The short name stays the same.</p>
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
export class Applications implements OnInit, OnDestroy {
  readonly #api = inject(CatalogApi);
  readonly #forms = inject(NonNullableFormBuilder);
  readonly #session = inject(SessionService);
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly applications = signal<Application[]>([]);
  protected readonly types = signal<ApplicationType[]>([]);
  protected readonly repositories = signal<ReadonlyMap<string, Repository>>(new Map());
  protected readonly access = signal<SourceAccess | null>(null);
  protected readonly status = signal<ApplicationStatus>('active');
  protected readonly loading = signal(true);
  readonly #activity = new PageActivity('clear-on-failure');
  protected readonly working = this.#activity.working;
  protected readonly error = this.#activity.error;
  protected readonly notice = this.#activity.notice;
  protected readonly editing = signal<Editing>(null);
  protected readonly chosenTypeKey = signal('');
  protected readonly canBuildTestImages = computed(() => {
    this.#session.user();
    return this.#session.can('feature-images:build');
  });
  protected readonly canManage = computed(() => {
    this.#session.user();
    return this.#session.can('applications:create');
  });
  protected readonly chosenType = computed(() => this.types().find((type) => type.key === this.chosenTypeKey()));
  protected readonly chosenLanguage = signal('');
  protected readonly chosenBlueprintKey = signal('');
  /** The languages the chosen type can be written in, such as TypeScript, JavaScript and Python. */
  protected readonly languages = computed(() => [
    ...new Set((this.chosenType()?.blueprints ?? []).map((blueprint) => blueprint.language)),
  ]);
  /** The frameworks the chosen type offers in the chosen language. */
  protected readonly frameworks = computed(() =>
    (this.chosenType()?.blueprints ?? []).filter((blueprint) => blueprint.language === this.chosenLanguage()),
  );
  protected readonly chosenBlueprint = computed(() =>
    this.frameworks().find((blueprint) => blueprint.key === this.chosenBlueprintKey()),
  );

  protected readonly registerForm = this.#forms.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(80)]],
    type: ['', Validators.required],
    language: ['', Validators.required],
    blueprint: ['', Validators.required],
    description: ['', Validators.maxLength(500)],
  });
  protected readonly editForm = this.#forms.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(80)]],
    description: ['', Validators.maxLength(500)],
  });

  constructor() {
    const { type, language, blueprint } = this.registerForm.controls;
    // A new type starts on its usual blueprint, and a new language on its first framework.
    type.valueChanges.subscribe((key) => {
      this.chosenTypeKey.set(key);
      const usual = this.chosenType()?.blueprint;
      language.setValue(usual?.language ?? '');
      blueprint.setValue(usual?.key ?? '');
    });
    language.valueChanges.subscribe((value) => {
      this.chosenLanguage.set(value);
      if (!this.frameworks().some((candidate) => candidate.key === blueprint.value)) {
        blueprint.setValue(this.frameworks()[0]?.key ?? '');
      }
    });
    blueprint.valueChanges.subscribe((key) => this.chosenBlueprintKey.set(key));
  }

  async ngOnInit(): Promise<void> {
    await this.#activity.run(async () => {
      if (this.canManage()) {
        const types = await this.#api.types();
        this.types.set(types);
        this.registerForm.controls.type.setValue(types[0]?.key ?? '');
      }
      await this.#refresh();
    });
    this.loading.set(false);
    // Git access isn't needed to use the page, so a failure here only hides the card.
    try {
      this.access.set(await this.#api.sourceAccess());
    } catch {
      this.access.set(null);
    }
  }

  ngOnDestroy(): void {
    clearTimeout(this.#refreshTimer);
  }

  /**
   * A repository is created in the background, so for a moment after registering there's
   * no record of it yet. Such an application shows as being created, not as missing.
   */
  protected isNew(application: Application): boolean {
    return application.status === 'active' && Date.now() - Date.parse(application.createdAt) < NEW_APPLICATION_MS;
  }

  protected teamLabel(team: TeamKey): string {
    return TEAMS[team].label;
  }

  protected teamAbility(team: TeamKey): string {
    return TEAMS[team].ability;
  }

  protected async checkAccess(): Promise<void> {
    await this.#activity.run(async () => {
      const access = await this.#api.syncSourceAccess();
      this.access.set(access);
      this.notice.set(
        access.hasAccount
          ? `You're in the ${this.teamLabel(access.team)} team now.`
          : "Forgejo doesn't have your account yet. Sign in to Forgejo first.",
      );
    });
  }

  protected async requestRepository(application: Application): Promise<void> {
    await this.#activity.run(async () => {
      await this.#api.requestRepository(application.id);
      this.notice.set(`The repository of ${application.name} is being created.`);
      await this.#refresh();
    });
  }

  protected isEditing(application: Application, kind: NonNullable<Editing>['kind']): boolean {
    const editing = this.editing();
    return editing?.id === application.id && editing.kind === kind;
  }

  protected async show(status: ApplicationStatus): Promise<void> {
    this.status.set(status);
    this.editing.set(null);
    this.notice.set(null);
    await this.#activity.run(() => this.#refresh());
  }

  protected startEdit(application: Application): void {
    this.editForm.setValue({ name: application.name, description: application.description });
    this.editing.set({ id: application.id, kind: 'edit' });
  }

  protected async register(): Promise<void> {
    const { name, type, language, blueprint, description } = this.registerForm.getRawValue();
    await this.#activity.run(async () => {
      const application = await this.#api.register({ name, type, blueprint, description });
      // The next one is likely of the same kind, so the choices stay.
      this.registerForm.reset({ name: '', type, language, blueprint, description: '' });
      this.notice.set(`${application.name} is registered.`);
      this.status.set('active');
      await this.#refresh();
    });
  }

  protected async save(application: Application): Promise<void> {
    await this.#activity.run(async () => {
      await this.#api.update(application.id, this.editForm.getRawValue());
      this.editing.set(null);
      await this.#refresh();
    });
  }

  protected async archive(application: Application): Promise<void> {
    await this.#activity.run(async () => {
      await this.#api.archive(application.id);
      this.editing.set(null);
      this.notice.set(`${application.name} is archived. You can restore it from the archived list.`);
      await this.#refresh();
    });
  }

  protected async restore(application: Application): Promise<void> {
    await this.#activity.run(async () => {
      await this.#api.restore(application.id);
      this.notice.set(`${application.name} is restored.`);
      await this.#refresh();
    });
  }

  /** Reloads the list, and keeps reloading while any repository is being created. */
  async #refresh(): Promise<void> {
    clearTimeout(this.#refreshTimer);
    const [applications, repositories] = await Promise.all([this.#api.list(this.status()), this.#api.repositories()]);
    this.applications.set(applications);
    this.repositories.set(new Map(repositories.map((repository) => [repository.applicationId, repository])));
    const waiting = applications.some(
      (application) => this.isNew(application) && !this.repositories().has(application.id),
    );
    if (waiting || repositories.some((repository) => repository.status === 'creating')) {
      this.#refreshTimer = setTimeout(() => void this.#activity.run(() => this.#refresh()), REFRESH_MS);
    }
  }
}
