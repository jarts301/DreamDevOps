import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { CurrentUser, SignedOut } from '@dreamdevops/contracts/identity-access/http';
import { BrowserNavigation } from './browser-navigation';

// Who is signed in is Identity and access's HTTP contract.
export type { CurrentUser, Membership } from '@dreamdevops/contracts/identity-access/http';

/** Who is signed in. The API holds the session, so this only ever reflects its answers. */
@Injectable({ providedIn: 'root' })
export class SessionService {
  readonly #http = inject(HttpClient);
  readonly #navigation = inject(BrowserNavigation);
  readonly #user = signal<CurrentUser | null>(null);
  #loaded = false;

  readonly user = this.#user.asReadonly();
  readonly isPlatformUser = computed(() => this.can('companies:manage'));

  /** Asks the API once. Pass refresh after something changes the user's access. */
  async load(options: { refresh?: boolean } = {}): Promise<CurrentUser | null> {
    if (this.#loaded && !options.refresh) {
      return this.#user();
    }
    try {
      const user = await firstValueFrom(this.#http.get<CurrentUser>('/api/v1/auth/me'));
      this.#user.set(user);
    } catch (error) {
      if (!(error instanceof HttpErrorResponse) || error.status !== 401) {
        throw error;
      }
      this.#user.set(null);
    }
    this.#loaded = true;
    return this.#user();
  }

  can(permission: string): boolean {
    return this.#user()?.permissions.includes(permission) ?? false;
  }

  signIn(): void {
    this.#navigation.go('/api/v1/auth/login');
  }

  async chooseCompany(companyId: string): Promise<void> {
    await firstValueFrom(this.#http.post('/api/v1/auth/active-company', { companyId }));
    await this.load({ refresh: true });
  }

  /** Ends the API's session, then sends the browser to end the login provider's session. */
  async signOut(): Promise<void> {
    const { logoutUrl } = await firstValueFrom(this.#http.post<SignedOut>('/api/v1/auth/logout', {}));
    this.#user.set(null);
    this.#navigation.go(logoutUrl ?? '/');
  }
}
