import type { CompanyNames as PublishedCompanyNames } from '@dreamdevops/contracts/notifications/services';
import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { CompanyNamesStore } from './ports.ts';

/**
 * The names chat messages give companies. Notifications keeps them itself, from Tenancy's
 * events, so a message never waits on Tenancy, or fails because it's down. A rename shows
 * in messages once its event arrives, a few seconds later at most.
 */
export class CompanyNames implements PublishedCompanyNames {
  readonly #store: CompanyNamesStore;

  constructor(store: CompanyNamesStore) {
    this.#store = store;
  }

  /** The current company's name, or null if Notifications hasn't heard it yet. */
  current(): Promise<string | null> {
    return this.#store.transaction((session) => session.name());
  }

  /** The current company was given this name at that time, by an event. */
  named(name: string, at: Date): Promise<void> {
    return this.#store.transaction((session) => session.named(name, at));
  }

  rememberIfUnknown(companyId: string, name: string): Promise<void> {
    return runWithCompany(parseCompanyId(companyId), () => this.#store.transaction((session) => session.rememberIfUnknown(name)));
  }
}
