import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api-error';
import { companyStatusLabel, resourceKindLabel, resourceStatusLabel } from './tenancy-labels';
import { type PlatformCompany, SLUG_PATTERN, suggestSlug, TenancyApi } from './tenancy.api';

/** Every company, for Platform Admins. It shows how each one is set up, never its data. */
@Component({
  selector: 'app-companies',
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Companies</h1>
    <p class="lead">Create companies and manage them from setup to closing. You see how each one is set up, not its data.</p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }

    <section class="card" aria-labelledby="new-company-heading">
      <h2 id="new-company-heading">New company</h2>
      <form class="form-row" [formGroup]="form" (ngSubmit)="create()">
        <label class="field">
          <span>Company name</span>
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
            aria-describedby="company-slug-hint"
            (input)="slugEdited = true"
          />
        </label>
        <button type="submit" class="button button-primary" [disabled]="form.invalid || working()">Create company</button>
      </form>
      <p id="company-slug-hint" class="hint">
        Lowercase letters, digits and hyphens. It names the company's Git organization, so it can't change later.
      </p>
    </section>

    <section class="card" aria-labelledby="companies-heading">
      <h2 id="companies-heading">All companies</h2>
      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else if (companies().length === 0) {
        <p class="muted">No companies yet. Create the first one above.</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Slug</th>
                <th scope="col">Status</th>
                <th scope="col">Resources</th>
                <th scope="col">Members</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              @for (company of companies(); track company.id) {
                <tr>
                  <td><a [routerLink]="['/platform/companies', company.id]">{{ company.name }}</a></td>
                  <td><code>{{ company.slug }}</code></td>
                  <td>
                    <span class="badge" [attr.data-status]="company.status">{{ companyStatusLabel(company.status) }}</span>
                  </td>
                  <td>
                    @for (resource of company.resources; track resource.kind) {
                      <span class="badge" [attr.data-status]="resource.status">
                        {{ resourceKindLabel(resource.kind) }}: {{ resourceStatusLabel(resource.status) }}
                      </span>
                    }
                  </td>
                  <td>{{ company.memberCount }}</td>
                  <td>{{ company.createdAt | date: 'mediumDate' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class Companies implements OnInit {
  readonly #api = inject(TenancyApi);
  readonly #router = inject(Router);
  readonly #forms = inject(NonNullableFormBuilder);

  protected readonly companyStatusLabel = companyStatusLabel;
  protected readonly resourceKindLabel = resourceKindLabel;
  protected readonly resourceStatusLabel = resourceStatusLabel;
  protected readonly companies = signal<PlatformCompany[]>([]);
  protected readonly loading = signal(true);
  protected readonly working = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly form = this.#forms.group({
    name: ['', [Validators.required, Validators.maxLength(100)]],
    slug: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(40), Validators.pattern(SLUG_PATTERN)]],
  });
  /** Once someone types a slug, the name stops replacing it. */
  protected slugEdited = false;

  async ngOnInit(): Promise<void> {
    try {
      this.companies.set(await this.#api.companies());
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected suggest(): void {
    if (!this.slugEdited) {
      this.form.controls.slug.setValue(suggestSlug(this.form.controls.name.value));
    }
  }

  protected async create(): Promise<void> {
    const { name, slug } = this.form.getRawValue();
    this.error.set(null);
    this.working.set(true);
    try {
      const company = await this.#api.createCompany(name, slug);
      await this.#router.navigate(['/platform/companies', company.id]);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.working.set(false);
    }
  }
}
