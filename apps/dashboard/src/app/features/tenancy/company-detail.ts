import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api-error';
import { type CreatedInvitation, IdentityAccessApi } from '../identity-access/identity-access.api';
import { InvitationResult } from '../identity-access/invitation-result';
import { companyStatusLabel, resourceKindLabel, resourceStatusLabel } from './tenancy-labels';
import { type CompanyAction, type PlatformCompany, POLL_INTERVAL_MS, TenancyApi } from './tenancy.api';

/** One company's setup and lifecycle, for Platform Admins. */
@Component({
  selector: 'app-company-detail',
  imports: [DatePipe, InvitationResult, ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="breadcrumb">
      <a routerLink="/platform/companies"><span aria-hidden="true">← </span>All companies</a>
    </p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }

    @if (company(); as company) {
      <h1>{{ company.name }}</h1>
      <p class="lead">
        <span class="badge" [attr.data-status]="company.status">{{ companyStatusLabel(company.status) }}</span>
        <code>{{ company.slug }}</code> · {{ company.memberCount }} {{ company.memberCount === 1 ? 'member' : 'members' }}
        · created {{ company.createdAt | date: 'mediumDate' }}
      </p>

      @if (company.status === 'erased') {
        @if (failed()) {
          <p class="alert alert-warning" role="status">
            A resource couldn't be erased yet. Its details below say why, and what to do.
          </p>
        } @else if (erasing()) {
          <p class="alert alert-info" role="status">
            Erasing the company's resources in other tools. This page updates by itself.
          </p>
        }
      } @else if (failed()) {
        <p class="alert alert-warning" role="status">
          A resource couldn't be provisioned. Its details below say why. Failures from Git hosting being unreachable are
          retried for a while by themselves.
        </p>
      } @else if (company.status === 'provisioning') {
        <p class="alert alert-info" role="status">
          Setting up the company's resources. Members can join once it's active. This page updates by itself.
        </p>
      }

      <section class="card" aria-labelledby="resources-heading">
        <h2 id="resources-heading">Resources</h2>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Resource</th>
                <th scope="col">Status</th>
                <th scope="col">Where</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              @for (resource of company.resources; track resource.kind) {
                <tr>
                  <td>{{ resourceKindLabel(resource.kind) }}</td>
                  <td>
                    <span class="badge" [attr.data-status]="resource.status">{{ resourceStatusLabel(resource.status) }}</span>
                  </td>
                  <td>
                    @if (resource.url) {
                      <a [href]="resource.url" target="_blank" rel="noopener noreferrer">{{ resource.name }}</a>
                    } @else if (resource.status === 'erased') {
                      <span class="muted">Deleted</span>
                    } @else if (company.status === 'erased') {
                      <span class="muted">To be deleted</span>
                    } @else {
                      <span class="muted">Not created yet</span>
                    }
                  </td>
                  <td>
                    @if (resource.lastError) {
                      {{ resource.lastError }}
                    }
                    @if (resource.attempts > 0) {
                      <span class="muted">
                        {{ resource.attempts }} {{ resource.attempts === 1 ? 'attempt' : 'attempts' }}, last
                        {{ resource.updatedAt | date: 'short' }}
                      </span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (canProvision()) {
          <div class="button-row card-actions">
            <button type="button" class="button" [disabled]="working()" (click)="provision()">
              {{ company.status === 'erased' ? 'Retry erasure' : 'Retry provisioning' }}
            </button>
          </div>
        }
      </section>

      @if (company.status !== 'closed' && company.status !== 'erased') {
        <section class="card" aria-labelledby="first-admin-heading">
          <h2 id="first-admin-heading">First admin</h2>
          @if (company.memberCount > 0) {
            <p class="muted">The company has members. Its Company Admins manage the team.</p>
          } @else if (company.status === 'active') {
            <p>Invite the person who will run the company. They become its first Company Admin.</p>
            <form class="form-row" [formGroup]="inviteForm" (ngSubmit)="invite()">
              <label class="field">
                <span>Email of the first admin</span>
                <input type="email" formControlName="email" autocomplete="off" required />
              </label>
              <button type="submit" class="button button-primary" [disabled]="inviteForm.invalid || working()">
                Create invitation
              </button>
            </form>
            @if (invited(); as result) {
              <app-invitation-result [invitation]="result.invitation" [email]="result.email" />
            }
          } @else {
            <p class="muted">You can invite the first admin once the company is active.</p>
          }
        </section>
      }

      @if (company.status !== 'closed' && company.status !== 'erased') {
        <section class="card" aria-labelledby="name-heading">
          <h2 id="name-heading">Name</h2>
          <form class="form-row" [formGroup]="nameForm" (ngSubmit)="rename()">
            <label class="field">
              <span>Company name</span>
              <input type="text" formControlName="name" autocomplete="off" maxlength="100" required />
            </label>
            <button type="submit" class="button" [disabled]="nameForm.invalid || !renamed() || working()">Save name</button>
          </form>
          <p class="hint">The slug stays the same, so the company's resources keep their names.</p>
        </section>
      }

      <section class="card" aria-labelledby="lifecycle-heading">
        <h2 id="lifecycle-heading">Lifecycle</h2>
        @switch (company.status) {
          @case ('provisioning') {
            <p>The company becomes active once its resources are ready. Close it if it was created by mistake.</p>
          }
          @case ('active') {
            <p>Suspending takes away every member's access until the company is reactivated. Nothing is deleted.</p>
          }
          @case ('suspended') {
            <p>Members can't use the company while it's suspended. Reactivating gives them access again.</p>
          }
          @case ('closed') {
            <p>This company is closed. Closing is permanent. Its data is kept until you erase it.</p>
          }
          @case ('erased') {
            <p>
              This company's data was erased on {{ company.erasedAt | date: 'medium' }}. Its records remain, with nothing
              left in them that identifies the company, its applications or the people it invited.
            </p>
          }
        }
        @if (company.status !== 'closed' && company.status !== 'erased') {
          <div class="button-row">
            @if (company.status === 'active') {
              <button type="button" class="button" [disabled]="working()" (click)="change('suspend')">Suspend company</button>
            }
            @if (company.status === 'suspended') {
              <button type="button" class="button" [disabled]="working()" (click)="change('reactivate')">
                Reactivate company
              </button>
            }
            @if (confirmingClose()) {
              <button type="button" class="button button-danger" [disabled]="working()" (click)="change('close')">
                Confirm close
              </button>
              <button type="button" class="button" (click)="confirmingClose.set(false)">Cancel</button>
            } @else {
              <button type="button" class="button" (click)="confirmingClose.set(true)">Close company</button>
            }
          </div>
          @if (confirmingClose()) {
            <p class="hint">Closing is permanent. Members lose access, and the company's data and resources are kept.</p>
          }
        }
      </section>

      @if (company.status === 'closed') {
        <section class="card card-danger" aria-labelledby="erase-heading">
          <h2 id="erase-heading">Erase company data</h2>
          <p>
            To meet data protection laws, erasing replaces everything that identifies the company, its applications and
            the people it invited. Its records stay, so history and references remain whole. Its Git organization is
            deleted once it has no repositories. This can't be undone.
          </p>
          <div class="form-row">
            <label class="field">
              <span>Type the slug {{ company.slug }} to confirm</span>
              <input
                type="text"
                autocomplete="off"
                [value]="eraseConfirmation()"
                (input)="eraseConfirmation.set($any($event.target).value)"
              />
            </label>
            <button
              type="button"
              class="button button-danger"
              [disabled]="eraseConfirmation() !== company.slug || working()"
              (click)="erase()"
            >
              Erase company data
            </button>
          </div>
        </section>
      }
    } @else if (loading()) {
      <p class="muted">Loading…</p>
    }
  `,
})
export class CompanyDetail implements OnInit {
  readonly #api = inject(TenancyApi);
  readonly #identity = inject(IdentityAccessApi);
  readonly #forms = inject(NonNullableFormBuilder);
  readonly #companyId = inject(ActivatedRoute).snapshot.paramMap.get('companyId') ?? '';
  readonly #pollIntervalMs = inject(POLL_INTERVAL_MS);
  #timer: ReturnType<typeof setTimeout> | undefined;
  #destroyed = false;

  protected readonly companyStatusLabel = companyStatusLabel;
  protected readonly resourceKindLabel = resourceKindLabel;
  protected readonly resourceStatusLabel = resourceStatusLabel;
  protected readonly company = signal<PlatformCompany | null>(null);
  protected readonly loading = signal(true);
  protected readonly working = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly confirmingClose = signal(false);
  protected readonly invited = signal<{ invitation: CreatedInvitation; email: string } | null>(null);
  protected readonly inviteForm = this.#forms.group({ email: ['', [Validators.required, Validators.email]] });
  protected readonly nameForm = this.#forms.group({ name: ['', [Validators.required, Validators.maxLength(100)]] });
  readonly #nameValue = signal('');
  protected readonly renamed = computed(() => this.#nameValue().trim() !== (this.company()?.name ?? ''));

  protected readonly failed = computed(
    () => this.company()?.resources.some((resource) => resource.status === 'failed') ?? false,
  );

  protected readonly erasing = computed(
    () => this.company()?.resources.some((resource) => resource.status === 'pending') ?? false,
  );
  protected readonly eraseConfirmation = signal('');

  /** Offered when a resource failed, or waits without anything working on it. */
  protected readonly canProvision = computed(() => {
    const company = this.company();
    if (company === null || company.status === 'closed') {
      return false;
    }
    if (company.status === 'erased') {
      return company.resources.some((resource) => resource.status === 'failed');
    }
    return company.resources.some(
      (resource) => resource.status === 'failed' || (resource.status === 'pending' && company.status !== 'provisioning'),
    );
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.#destroyed = true;
      clearTimeout(this.#timer);
    });
    this.nameForm.controls.name.valueChanges.subscribe((value) => this.#nameValue.set(value));
  }

  async ngOnInit(): Promise<void> {
    try {
      this.#show(await this.#api.company(this.#companyId));
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected async invite(): Promise<void> {
    const { email } = this.inviteForm.getRawValue();
    this.invited.set(null);
    await this.#attempt(async () => {
      const invitation = await this.#identity.inviteFirstAdmin(this.#companyId, email);
      this.invited.set({ invitation, email });
      this.inviteForm.reset();
    });
  }

  protected async rename(): Promise<void> {
    const { name } = this.nameForm.getRawValue();
    await this.#attempt(async () => this.#show(await this.#api.renameCompany(this.#companyId, name), true));
  }

  protected async change(action: CompanyAction): Promise<void> {
    await this.#attempt(async () => {
      this.#show(await this.#api.changeCompanyStatus(this.#companyId, action));
      this.confirmingClose.set(false);
    });
  }

  protected async erase(): Promise<void> {
    await this.#attempt(async () => {
      this.#show(await this.#api.eraseCompany(this.#companyId, this.eraseConfirmation()));
      this.eraseConfirmation.set('');
    });
  }

  protected async provision(): Promise<void> {
    await this.#attempt(async () => this.#show(await this.#api.provisionCompany(this.#companyId)));
  }

  /** Shows the company, and keeps checking while its resources are being set up. */
  #show(company: PlatformCompany, resetName = false): void {
    this.company.set(company);
    if (resetName || this.nameForm.pristine) {
      this.nameForm.reset({ name: company.name });
    }
    clearTimeout(this.#timer);
    const settling =
      company.status === 'provisioning' || company.resources.some((resource) => resource.status === 'pending');
    if (settling && !this.#destroyed) {
      this.#timer = setTimeout(() => void this.#refresh(), this.#pollIntervalMs);
    }
  }

  async #refresh(): Promise<void> {
    try {
      this.#show(await this.#api.company(this.#companyId));
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  async #attempt(work: () => Promise<void>): Promise<void> {
    this.error.set(null);
    this.working.set(true);
    try {
      await work();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.working.set(false);
    }
  }
}
