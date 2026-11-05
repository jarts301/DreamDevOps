import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api-error';
import { SessionService } from '../../core/session.service';
import {
  ApplicationCatalogApi,
  type ApplicationType,
  EMPTY_REPOSITORY,
} from '../application-catalog/application-catalog.api';
import { ApplicationTypePicker } from '../application-catalog/application-type-picker';
import { ScaffoldPicker } from '../application-catalog/scaffold-picker';
import { resourceStatusLabel } from './tenancy-labels';
import {
  type Application,
  type ApplicationAction,
  type CompanyProfile,
  POLL_INTERVAL_MS,
  SLUG_PATTERN,
  suggestSlug,
  TenancyApi,
} from './tenancy.api';


/** The current company's applications. Who may change them is decided by the API. */
@Component({
  selector: 'app-applications',
  imports: [ApplicationTypePicker, DatePipe, ReactiveFormsModule, RouterLink, ScaffoldPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Applications</h1>
    <p class="lead">
      The software {{ profile()?.name ?? 'your company' }} builds and runs.
      @if (gitOrganization(); as organization) {
        Its code lives in the
        <a [href]="organization.url" target="_blank" rel="noopener noreferrer">{{ organization.name }}</a>
        Git organization.
      }
      <a routerLink="/applications/types">See what each application type needs</a>.
    </p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }

    @if (editing(); as application) {
      <section class="card" aria-labelledby="edit-heading">
        <h2 id="edit-heading">Edit {{ application.name }}</h2>
        <form class="form-stack" [formGroup]="editForm" (ngSubmit)="save(application)">
          <label class="field">
            <span>Name</span>
            <input type="text" formControlName="name" autocomplete="off" maxlength="100" required />
          </label>
          <label class="field">
            <span>Description</span>
            <textarea formControlName="description" rows="3" maxlength="500"></textarea>
          </label>
          <div class="button-row">
            <button type="submit" class="button button-primary" [disabled]="editForm.invalid || working()">
              Save changes
            </button>
            <button type="button" class="button" (click)="editing.set(null)">Cancel</button>
          </div>
        </form>
      </section>
    } @else if (can().create) {
      <section class="card" aria-labelledby="new-application-heading">
        <h2 id="new-application-heading">New application</h2>
        <form class="form-stack" [formGroup]="createForm" (ngSubmit)="create()">
          <app-application-type-picker [types]="types()" [control]="createForm.controls.type" />
          <app-scaffold-picker [type]="chosenType()" [control]="createForm.controls.scaffold" />
          <div class="form-row">
            <label class="field">
              <span>Application name</span>
              <input type="text" formControlName="name" autocomplete="off" maxlength="100" required (input)="suggest()" />
            </label>
            <label class="field">
              <span>Slug</span>
              <input
                type="text"
                formControlName="slug"
                autocomplete="off"
                maxlength="40"
                required
                aria-describedby="application-slug-hint"
                (input)="slugEdited = true"
              />
            </label>
          </div>
          <p id="application-slug-hint" class="hint">Lowercase letters, digits and hyphens. It can't change later.</p>
          <label class="field">
            <span>Description (optional)</span>
            <textarea formControlName="description" rows="2" maxlength="500"></textarea>
          </label>
          <div class="button-row">
            <button type="submit" class="button button-primary" [disabled]="createForm.invalid || working()">
              Create application
            </button>
          </div>
        </form>
      </section>
    }

    <section class="card" aria-labelledby="active-heading">
      <h2 id="active-heading">Active applications</h2>
      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else if (active().length === 0) {
        <p class="muted">
          No applications yet.
          @if (can().create) {
            Create the first one above.
          } @else {
            A Company Admin or Tech Lead can create one.
          }
        </p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Slug</th>
                <th scope="col">Type</th>
                <th scope="col">Repository</th>
                <th scope="col">Description</th>
                <th scope="col">Created</th>
                @if (can().update || can().archive) {
                  <th scope="col"><span class="visually-hidden">Actions</span></th>
                }
              </tr>
            </thead>
            <tbody>
              @for (application of active(); track application.id) {
                <tr>
                  <td>{{ application.name }}</td>
                  <td><code>{{ application.slug }}</code></td>
                  <td>
                    {{ typeName(application.type) }}
                    @if (scaffoldName(application); as scaffold) {
                      <span class="muted">· {{ scaffold }}</span>
                    }
                  </td>
                  <td>
                    @if (application.repository; as repository) {
                      @if (repository.status === 'ready' && repository.url) {
                        <a [href]="repository.url" target="_blank" rel="noopener noreferrer">{{ repository.name }}</a>
                      } @else {
                        <span class="badge" [attr.data-status]="repository.status">
                          {{ repository.status === 'pending' ? 'Setting up' : resourceStatusLabel(repository.status) }}
                        </span>
                        @if (repository.lastError) {
                          <span class="hint-inline">{{ repository.lastError }}</span>
                        }
                        @if (repository.status !== 'pending' && can().create) {
                          <button
                            type="button"
                            class="button button-small"
                            [attr.aria-label]="'Retry the repository of ' + application.name"
                            [disabled]="working()"
                            (click)="retryRepository(application)"
                          >
                            Retry
                          </button>
                        }
                      }
                    } @else {
                      <span class="muted">None</span>
                    }
                  </td>
                  <td>{{ application.description }}</td>
                  <td>{{ application.createdAt | date: 'mediumDate' }}</td>
                  @if (can().update || can().archive) {
                    <td class="cell-actions">
                      @if (can().update) {
                        <button
                          type="button"
                          class="button"
                          [attr.aria-label]="'Edit ' + application.name"
                          (click)="edit(application)"
                        >
                          Edit
                        </button>
                      }
                      @if (can().archive) {
                        <button
                          type="button"
                          class="button"
                          [attr.aria-label]="'Archive ' + application.name"
                          [disabled]="working()"
                          (click)="change(application, 'archive')"
                        >
                          Archive
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
    </section>

    @if (archived().length > 0) {
      <section class="card" aria-labelledby="archived-heading">
        <h2 id="archived-heading">Archived applications</h2>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Slug</th>
                <th scope="col">Archived</th>
                @if (can().archive) {
                  <th scope="col"><span class="visually-hidden">Actions</span></th>
                }
              </tr>
            </thead>
            <tbody>
              @for (application of archived(); track application.id) {
                <tr>
                  <td>{{ application.name }}</td>
                  <td><code>{{ application.slug }}</code></td>
                  <td>{{ application.archivedAt | date: 'mediumDate' }}</td>
                  @if (can().archive) {
                    <td class="cell-actions">
                      <button
                        type="button"
                        class="button"
                        [attr.aria-label]="'Restore ' + application.name"
                        [disabled]="working()"
                        (click)="change(application, 'restore')"
                      >
                        Restore
                      </button>
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    }
  `,
})
export class Applications implements OnInit {
  readonly #api = inject(TenancyApi);
  readonly #catalog = inject(ApplicationCatalogApi);
  readonly #session = inject(SessionService);
  readonly #forms = inject(NonNullableFormBuilder);

  protected readonly applications = signal<Application[]>([]);
  protected readonly profile = signal<CompanyProfile | null>(null);
  protected readonly types = signal<ApplicationType[]>([]);
  readonly #typeNames = computed(() => new Map(this.types().map((type) => [type.key, type.name])));
  protected readonly loading = signal(true);
  protected readonly working = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly editing = signal<Application | null>(null);
  /** Each action shows only to people with its permission. The API checks them again. */
  protected readonly can = computed(() => {
    // Reading the user keeps this current after the user's access changes.
    this.#session.user();
    return {
      create: this.#session.can('applications:create'),
      update: this.#session.can('applications:update'),
      archive: this.#session.can('applications:archive'),
    };
  });
  protected readonly active = computed(() => this.applications().filter((application) => application.status === 'active'));
  protected readonly archived = computed(() =>
    this.applications().filter((application) => application.status === 'archived'),
  );
  protected readonly gitOrganization = computed(() => {
    const resource = this.profile()?.resources.find((candidate) => candidate.kind === 'git-organization');
    return resource?.status === 'ready' && resource.url !== null ? { name: resource.name, url: resource.url } : null;
  });

  protected readonly createForm = this.#forms.group({
    type: ['', Validators.required],
    scaffold: ['', Validators.required],
    name: ['', [Validators.required, Validators.maxLength(100)]],
    slug: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(40), Validators.pattern(SLUG_PATTERN)]],
    description: ['', Validators.maxLength(500)],
  });
  protected readonly editForm = this.#forms.group({
    name: ['', [Validators.required, Validators.maxLength(100)]],
    description: ['', Validators.maxLength(500)],
  });
  /** Once someone types a slug, the name stops replacing it. */
  protected slugEdited = false;
  protected readonly resourceStatusLabel = resourceStatusLabel;
  readonly #chosenTypeKey = signal('');
  protected readonly chosenType = computed(
    () => this.types().find((type) => type.key === this.#chosenTypeKey()) ?? null,
  );
  readonly #pollIntervalMs = inject(POLL_INTERVAL_MS);
  #timer: ReturnType<typeof setTimeout> | undefined;
  #destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.#destroyed = true;
      clearTimeout(this.#timer);
    });
    // A new type offers its own scaffolds, so the first one is chosen for it.
    this.createForm.controls.type.valueChanges.subscribe((key) => {
      this.#chosenTypeKey.set(key);
      const type = this.types().find((candidate) => candidate.key === key);
      this.createForm.controls.scaffold.setValue(type === undefined ? '' : (type.scaffolds[0]?.key ?? EMPTY_REPOSITORY));
    });
  }

  async ngOnInit(): Promise<void> {
    await this.#attempt(async () => {
      const [profile, applications, types] = await Promise.all([
        this.#api.currentCompany(),
        this.#api.applications(),
        this.#catalog.types(),
      ]);
      this.profile.set(profile);
      this.types.set(types);
      this.#show(applications);
    });
    this.loading.set(false);
  }

  protected scaffoldName(application: Application): string | null {
    if (application.scaffold === null) {
      return null;
    }
    const type = this.types().find((candidate) => candidate.key === application.type);
    return type?.scaffolds.find((scaffold) => scaffold.key === application.scaffold)?.name ?? application.scaffold;
  }

  protected async retryRepository(application: Application): Promise<void> {
    await this.#attempt(async () => {
      await this.#api.requestRepository(application.id);
      await this.#refresh();
    });
  }

  /** A type the catalog no longer has still shows, by its key. */
  protected typeName(key: string | null): string {
    return key === null ? 'Not set' : (this.#typeNames().get(key) ?? key);
  }

  protected suggest(): void {
    if (!this.slugEdited) {
      this.createForm.controls.slug.setValue(suggestSlug(this.createForm.controls.name.value));
    }
  }

  protected async create(): Promise<void> {
    await this.#attempt(async () => {
      const { scaffold, ...rest } = this.createForm.getRawValue();
      await this.#api.createApplication({ ...rest, scaffold: scaffold === EMPTY_REPOSITORY ? null : scaffold });
      this.createForm.reset();
      this.slugEdited = false;
      await this.#refresh();
    });
  }

  protected edit(application: Application): void {
    this.error.set(null);
    this.editForm.reset({ name: application.name, description: application.description });
    this.editing.set(application);
  }

  protected async save(application: Application): Promise<void> {
    await this.#attempt(async () => {
      await this.#api.updateApplication(application.id, this.editForm.getRawValue());
      this.editing.set(null);
      await this.#refresh();
    });
  }

  protected async change(application: Application, action: ApplicationAction): Promise<void> {
    await this.#attempt(async () => {
      await this.#api.changeApplicationStatus(application.id, action);
      if (this.editing()?.id === application.id) {
        this.editing.set(null);
      }
      await this.#refresh();
    });
  }

  async #refresh(): Promise<void> {
    this.#show(await this.#api.applications());
  }

  /** Shows the applications, and checks again while a repository is being made. */
  #show(applications: Application[]): void {
    this.applications.set(applications);
    clearTimeout(this.#timer);
    if (!this.#destroyed && applications.some((application) => application.repository?.status === 'pending')) {
      this.#timer = setTimeout(() => void this.#attempt(() => this.#refresh(), false), this.#pollIntervalMs);
    }
  }

  /** Checking in the background doesn't disable the page's buttons. */
  async #attempt(work: () => Promise<void>, busy = true): Promise<void> {
    this.error.set(null);
    this.working.set(busy);
    try {
      await work();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.working.set(false);
    }
  }
}
