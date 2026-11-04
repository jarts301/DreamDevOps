import { ChangeDetectionStrategy, Component, DOCUMENT, inject, type OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { errorMessage } from '../../core/api-error';
import { roleName } from '../../core/labels';
import { PendingInvitation } from '../../core/pending-invitation';
import { SessionService } from '../../core/session.service';
import { IdentityAccessApi } from './identity-access.api';

/**
 * Joining needs a click rather than happening on page load, so following a link
 * can't add someone to a company without them knowing.
 */
@Component({
  selector: 'app-accept-invitation',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="centered-page">
      <div class="card">
        <h1>Join a company</h1>
        @if (!hasToken()) {
          <p>This invitation link isn't complete. Ask for a new one.</p>
          <p><a routerLink="/">Go to the overview</a></p>
        } @else if (session.user(); as user) {
          <p>You're signed in as <strong>{{ user.email }}</strong>. The invitation must be for this address.</p>
          @if (error(); as message) {
            <p class="alert alert-error" role="alert">{{ message }}</p>
          }
          <div class="button-row">
            <button type="button" class="button button-primary" [disabled]="working()" (click)="accept()">
              Accept invitation
            </button>
            <button type="button" class="button" [disabled]="working()" (click)="decline()">Not now</button>
            @if (error()) {
              <button type="button" class="button" (click)="switchAccount()">Use another account</button>
            }
          </div>
        }
      </div>
    </main>
  `,
})
export class AcceptInvitation implements OnInit {
  readonly #api = inject(IdentityAccessApi);
  readonly #route = inject(ActivatedRoute);
  readonly #router = inject(Router);
  readonly #pending = inject(PendingInvitation);
  readonly #document = inject(DOCUMENT);

  protected readonly session = inject(SessionService);
  protected readonly roleName = roleName;
  protected readonly hasToken = signal(false);
  protected readonly working = signal(false);
  protected readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    const fragment = new URLSearchParams(this.#route.snapshot.fragment ?? '');
    const token = fragment.get('token');
    if (token !== null) {
      this.#pending.set(token);
      // The token no longer needs to sit in the address bar or the browser's history.
      this.#document.defaultView?.history.replaceState(null, '', '/invitations/accept');
    }
    this.hasToken.set(this.#pending.get() !== null);

    if (this.hasToken() && (await this.session.load()) === null) {
      this.session.signIn();
    }
  }

  protected async accept(): Promise<void> {
    const token = this.#pending.get();
    if (token === null) {
      return;
    }
    this.error.set(null);
    this.working.set(true);
    try {
      const joined = await this.#api.acceptInvitation(token);
      this.#pending.clear();
      await this.session.load({ refresh: true });
      if (this.session.user()?.companyId !== joined.companyId) {
        await this.session.chooseCompany(joined.companyId);
      }
      await this.#router.navigateByUrl('/');
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.working.set(false);
    }
  }

  protected async decline(): Promise<void> {
    this.#pending.clear();
    await this.#router.navigateByUrl('/');
  }

  /** Keeps the invitation, so it can be accepted after signing in as someone else. */
  protected async switchAccount(): Promise<void> {
    try {
      await this.session.signOut();
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }
}
