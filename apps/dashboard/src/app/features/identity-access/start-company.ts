import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { errorMessage } from '../../core/api-error';
import { type CreatedInvitation, IdentityAccessApi } from './identity-access.api';
import { InvitationResult } from './invitation-result';

/** Temporary until Tenancy exists: a company is only an ID, created by inviting its first admin. */
@Component({
  selector: 'app-start-company',
  imports: [InvitationResult, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Start a company</h1>
    <p class="lead">Invite the person who will run the company. They become its first Company Admin.</p>

    @if (error(); as message) {
      <p class="alert alert-error" role="alert">{{ message }}</p>
    }

    <section class="card">
      <form class="form-row" [formGroup]="form" (ngSubmit)="start()">
        <label class="field">
          <span>Email of the first admin</span>
          <input type="email" formControlName="email" autocomplete="off" required />
        </label>
        <button type="submit" class="button button-primary" [disabled]="form.invalid || working()">
          Create invitation
        </button>
      </form>
      @if (created(); as result) {
        <app-invitation-result [invitation]="result.invitation" [email]="result.email" />
      }
    </section>
  `,
})
export class StartCompany {
  readonly #api = inject(IdentityAccessApi);
  readonly #forms = inject(NonNullableFormBuilder);

  protected readonly working = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly created = signal<{ invitation: CreatedInvitation; email: string } | null>(null);
  protected readonly form = this.#forms.group({ email: ['', [Validators.required, Validators.email]] });

  protected async start(): Promise<void> {
    const { email } = this.form.getRawValue();
    this.error.set(null);
    this.created.set(null);
    this.working.set(true);
    try {
      const invitation = await this.#api.inviteFirstAdmin(crypto.randomUUID(), email);
      this.created.set({ invitation, email });
      this.form.reset();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.working.set(false);
    }
  }
}
