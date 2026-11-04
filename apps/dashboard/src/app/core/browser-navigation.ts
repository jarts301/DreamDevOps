import { DOCUMENT, inject, Injectable } from '@angular/core';

/** Full page moves, such as to the login provider. Kept separate so tests can replace it. */
@Injectable({ providedIn: 'root' })
export class BrowserNavigation {
  readonly #document = inject(DOCUMENT);

  go(url: string): void {
    this.#document.location.assign(url);
  }
}
