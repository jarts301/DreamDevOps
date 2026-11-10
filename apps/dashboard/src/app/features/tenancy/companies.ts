import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, type OnDestroy, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { PageActivity } from '../../core/page-activity';
import type { CreatedInvitation } from '../identity-access/identity-access.api';
import { InvitationResult } from '../identity-access/invitation-result';
import { type Company, type CompanyStatus, TenancyApi } from './tenancy.api';

const STATUS_LABELS: Readonly<Record<CompanyStatus, string>> = {
  provisioning: 'Setting up',
  active: 'Active',
  'provisioning-failed': 'Setup failed',
  suspended: 'Suspended',
};

/** How often the list refreshes while a company is being set up. */
const REFRESH_MS = 3_000;

type Editing = { readonly id: string; readonly kind: 'rename' | 'invite' | 'suspend' } | null;

@Component({
  selector: 'app-companies',
  imports: [DatePipe, InvitationResult, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Companies</h1>
    <p class="lead">You can manage companies here, but you can't see their data.</p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }

    <section class="card" aria-labelledby="create-heading">
      <h2 id="create-heading">Start a company</h2>
      <form class="form-row" [formGroup]="createForm" (ngSubmit)="create()">
        <label class="field">
          <span>Company name</span>
          <input type="text" formControlName="name" maxlength="80" autocomplete="off" required />
        </label>
        <label class="field">
          <span>Email of the first admin</span>
          <input type="email" formControlName="email" autocomplete="off" required />
        </label>
        <button type="submit" class="button button-primary" [disabled]="createForm.invalid || working()">
          Create company
        </button>
      </form>
      @if (invitation(); as result) {
        <app-invitation-result [invitation]="result.invitation" [email]="result.email" />
      }
    </section>

    <section class="card" aria-labelledby="list-heading">
      <h2 id="list-heading">All companies</h2>
      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else if (companies().length === 0) {
        <p class="muted">No companies yet.</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Short name</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col"><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (company of companies(); track company.id) {
                <tr>
                  <td>
                    @if (isEditing(company, 'rename')) {
                      <form class="inline-form" [formGroup]="renameForm" (ngSubmit)="rename(company)">
                        <input
                          type="text"
                          formControlName="name"
                          maxlength="80"
                          [attr.aria-label]="'New name for ' + company.name"
                        />
                        <button type="submit" class="button" [disabled]="renameForm.invalid || working()">Save</button>
                        <button type="button" class="button" (click)="editing.set(null)">Cancel</button>
                      </form>
                    } @else {
                      {{ company.name }}
                    }
                  </td>
                  <td><code>{{ company.slug }}</code></td>
                  <td>
                    <span class="status" [attr.data-status]="company.status">{{ statusLabel(company.status) }}</span>
                    @if (company.status === 'provisioning-failed' && company.provisioningError) {
                      <p class="cell-note">{{ company.provisioningError }}</p>
                    }
                  </td>
                  <td>{{ company.createdAt | date: 'mediumDate' }}</td>
                  <td class="cell-actions">
                    @if (isEditing(company, 'suspend')) {
                      <button type="button" class="button button-danger" [disabled]="working()" (click)="suspend(company)">
                        Confirm suspension
                      </button>
                      <button type="button" class="button" (click)="editing.set(null)">Cancel</button>
                    } @else if (company.status === 'suspended') {
                      <button
                        type="button"
                        class="button"
                        [attr.aria-label]="'Reactivate ' + company.name"
                        [disabled]="working()"
                        (click)="reactivate(company)"
                      >
                        Reactivate
                      </button>
                    } @else {
                      @if (company.status === 'provisioning-failed') {
                        <button
                          type="button"
                          class="button"
                          [attr.aria-label]="'Retry setup of ' + company.name"
                          [disabled]="working()"
                          (click)="retry(company)"
                        >
                          Retry setup
                        </button>
                      }
                      <button
                        type="button"
                        class="button"
                        [attr.aria-label]="'Rename ' + company.name"
                        (click)="startRename(company)"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        class="button"
                        [attr.aria-label]="'New first-admin invitation for ' + company.name"
                        (click)="editing.set({ id: company.id, kind: 'invite' })"
                      >
                        Invite admin
                      </button>
                      <button
                        type="button"
                        class="button"
                        [attr.aria-label]="'Suspend ' + company.name"
                        (click)="editing.set({ id: company.id, kind: 'suspend' })"
                      >
                        Suspend
                      </button>
                    }
                  </td>
                </tr>
                @if (isEditing(company, 'invite')) {
                  <tr>
                    <td colspan="5">
                      <form class="form-row" [formGroup]="inviteForm" (ngSubmit)="inviteAdmin(company)">
                        <label class="field">
                          <span>Email of the first admin of {{ company.name }}</span>
                          <input type="email" formControlName="email" autocomplete="off" required />
                        </label>
                        <button type="submit" class="button button-primary" [disabled]="inviteForm.invalid || working()">
                          Create invitation
                        </button>
                        <button type="button" class="button" (click)="editing.set(null)">Cancel</button>
                      </form>
                      <p class="cell-note">This only works while the company has no members.</p>
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
export class Companies implements OnInit, OnDestroy {
  readonly #api = inject(TenancyApi);
  readonly #forms = inject(NonNullableFormBuilder);
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly companies = signal<Company[]>([]);
  protected readonly loading = signal(true);
  readonly #activity = new PageActivity('no-notice');
  protected readonly working = this.#activity.working;
  protected readonly error = this.#activity.error;
  protected readonly editing = signal<Editing>(null);
  protected readonly invitation = signal<{ invitation: CreatedInvitation; email: string } | null>(null);

  protected readonly createForm = this.#forms.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(80)]],
    email: ['', [Validators.required, Validators.email]],
  });
  protected readonly renameForm = this.#forms.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(80)]],
  });
  protected readonly inviteForm = this.#forms.group({ email: ['', [Validators.required, Validators.email]] });

  async ngOnInit(): Promise<void> {
    await this.#activity.run(() => this.#refresh());
    this.loading.set(false);
  }

  ngOnDestroy(): void {
    clearTimeout(this.#refreshTimer);
  }

  protected statusLabel(status: CompanyStatus): string {
    return STATUS_LABELS[status];
  }

  protected isEditing(company: Company, kind: NonNullable<Editing>['kind']): boolean {
    const editing = this.editing();
    return editing?.id === company.id && editing.kind === kind;
  }

  protected startRename(company: Company): void {
    this.renameForm.setValue({ name: company.name });
    this.editing.set({ id: company.id, kind: 'rename' });
  }

  protected async create(): Promise<void> {
    const { name, email } = this.createForm.getRawValue();
    this.invitation.set(null);
    await this.#activity.run(async () => {
      const { invitation } = await this.#api.create(name, email);
      this.invitation.set({ invitation, email });
      this.createForm.reset();
      await this.#refresh();
    });
  }

  protected async rename(company: Company): Promise<void> {
    await this.#activity.run(async () => {
      await this.#api.rename(company.id, this.renameForm.getRawValue().name);
      this.editing.set(null);
      await this.#refresh();
    });
  }

  protected async suspend(company: Company): Promise<void> {
    await this.#activity.run(async () => {
      await this.#api.suspend(company.id);
      this.editing.set(null);
      await this.#refresh();
    });
  }

  protected async reactivate(company: Company): Promise<void> {
    await this.#activity.run(async () => {
      await this.#api.reactivate(company.id);
      await this.#refresh();
    });
  }

  protected async retry(company: Company): Promise<void> {
    await this.#activity.run(async () => {
      await this.#api.retryProvisioning(company.id);
      await this.#refresh();
    });
  }

  protected async inviteAdmin(company: Company): Promise<void> {
    const { email } = this.inviteForm.getRawValue();
    this.invitation.set(null);
    await this.#activity.run(async () => {
      const invitation = await this.#api.inviteFirstAdmin(company.id, email);
      this.invitation.set({ invitation, email });
      this.inviteForm.reset();
      this.editing.set(null);
    });
  }

  /** Reloads the list, and keeps reloading while any company is still being set up. */
  async #refresh(): Promise<void> {
    clearTimeout(this.#refreshTimer);
    const companies = await this.#api.list();
    this.companies.set(companies);
    if (companies.some((company) => company.status === 'provisioning')) {
      this.#refreshTimer = setTimeout(() => void this.#activity.run(() => this.#refresh()), REFRESH_MS);
    }
  }
}
