import { inject, Injectable, InjectionToken } from '@angular/core';

export const SESSION_STORAGE = new InjectionToken<Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>>(
  'SESSION_STORAGE',
  { factory: () => sessionStorage },
);

const KEY = 'dreamdevops.pendingInvitation';

/**
 * Keeps an invitation token across the login redirect, because login always returns
 * to the dashboard's start page. It stays in this tab only and is cleared once used.
 */
@Injectable({ providedIn: 'root' })
export class PendingInvitation {
  readonly #storage = inject(SESSION_STORAGE);

  get(): string | null {
    return this.#storage.getItem(KEY);
  }

  set(token: string): void {
    this.#storage.setItem(KEY, token);
  }

  clear(): void {
    this.#storage.removeItem(KEY);
  }
}
