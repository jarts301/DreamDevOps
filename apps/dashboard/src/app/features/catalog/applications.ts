import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { errorMessage } from '../../core/api-error';
import { SessionService } from '../../core/session.service';
import { type Application, type ApplicationStatus, type ApplicationType, CatalogApi } from './catalog.api';

type Editing = { readonly id: string; readonly kind: 'edit' | 'archive' } | null;

/** The company's applications. Every member can see them, and Tech Leads and Company Admins manage them. */
@Component({
  selector: 'app-applications',
  imports: [DatePipe, ReactiveFormsModule],
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
          <label class="field field-wide">
            <span>Description (optional)</span>
            <textarea formControlName="description" rows="2" maxlength="500"></textarea>
          </label>
          <button type="submit" class="button button-primary" [disabled]="registerForm.invalid || working()">
            Register application
          </button>
        </form>
        @if (chosenType(); as type) {
          <p class="cell-note">{{ type.name }}: {{ type.description }}</p>
        }
        <p class="cell-note">Registering doesn't create a repository yet.</p>
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
                <tr>
                  <td>
                    {{ application.name }}
                    @if (application.description) {
                      <p class="cell-note">{{ application.description }}</p>
                    }
                  </td>
                  <td>{{ application.type.name }}</td>
                  <td><code>{{ application.slug }}</code></td>
                  <td><span class="muted">Not created yet</span></td>
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
export class Applications implements OnInit {
  readonly #api = inject(CatalogApi);
  readonly #forms = inject(NonNullableFormBuilder);
  readonly #session = inject(SessionService);

  protected readonly applications = signal<Application[]>([]);
  protected readonly types = signal<ApplicationType[]>([]);
  protected readonly status = signal<ApplicationStatus>('active');
  protected readonly loading = signal(true);
  protected readonly working = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly editing = signal<Editing>(null);
  protected readonly chosenTypeKey = signal('');
  protected readonly canManage = computed(() => {
    this.#session.user();
    return this.#session.can('applications:create');
  });
  protected readonly chosenType = computed(() => this.types().find((type) => type.key === this.chosenTypeKey()));

  protected readonly registerForm = this.#forms.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(80)]],
    type: ['', Validators.required],
    description: ['', Validators.maxLength(500)],
  });
  protected readonly editForm = this.#forms.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(80)]],
    description: ['', Validators.maxLength(500)],
  });

  constructor() {
    this.registerForm.controls.type.valueChanges.subscribe((key) => this.chosenTypeKey.set(key));
  }

  async ngOnInit(): Promise<void> {
    await this.#attempt(async () => {
      if (this.canManage()) {
        const types = await this.#api.types();
        this.types.set(types);
        this.registerForm.controls.type.setValue(types[0]?.key ?? '');
      }
      await this.#refresh();
    });
    this.loading.set(false);
  }

  protected isEditing(application: Application, kind: NonNullable<Editing>['kind']): boolean {
    const editing = this.editing();
    return editing?.id === application.id && editing.kind === kind;
  }

  protected async show(status: ApplicationStatus): Promise<void> {
    this.status.set(status);
    this.editing.set(null);
    this.notice.set(null);
    await this.#attempt(() => this.#refresh());
  }

  protected startEdit(application: Application): void {
    this.editForm.setValue({ name: application.name, description: application.description });
    this.editing.set({ id: application.id, kind: 'edit' });
  }

  protected async register(): Promise<void> {
    const { name, type, description } = this.registerForm.getRawValue();
    await this.#attempt(async () => {
      const application = await this.#api.register({ name, type, description });
      this.registerForm.reset({ name: '', type, description: '' });
      this.notice.set(`${application.name} is registered.`);
      this.status.set('active');
      await this.#refresh();
    });
  }

  protected async save(application: Application): Promise<void> {
    await this.#attempt(async () => {
      await this.#api.update(application.id, this.editForm.getRawValue());
      this.editing.set(null);
      await this.#refresh();
    });
  }

  protected async archive(application: Application): Promise<void> {
    await this.#attempt(async () => {
      await this.#api.archive(application.id);
      this.editing.set(null);
      this.notice.set(`${application.name} is archived. You can restore it from the archived list.`);
      await this.#refresh();
    });
  }

  protected async restore(application: Application): Promise<void> {
    await this.#attempt(async () => {
      await this.#api.restore(application.id);
      this.notice.set(`${application.name} is restored.`);
      await this.#refresh();
    });
  }

  async #refresh(): Promise<void> {
    this.applications.set(await this.#api.list(this.status()));
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
