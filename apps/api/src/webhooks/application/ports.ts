import type { EventLog, Transactional } from '@dreamdevops/shared-kernel';

/** Which application, of which company, a repository belongs to. */
export interface RepositoryOwner {
  readonly applicationId: string;
  readonly companyId: string;
}

/** Deliveries already taken, in one transaction. */
export interface DeliveriesSession extends EventLog {
  /**
   * The repository's owner, found before any company's context is known, from the
   * repository's organization and name. Null for a repository the platform didn't make.
   */
  ownerOf(organization: string, name: string): Promise<RepositoryOwner | null>;
  /** Takes a delivery, unless it was taken before. False for a repeat. */
  take(delivery: { readonly deliveryId: string; readonly companyId: string; readonly applicationId: string; readonly event: string }): Promise<boolean>;
}

export const DELIVERIES_STORE = Symbol('DELIVERIES_STORE');

export type DeliveriesStore = Transactional<DeliveriesSession>;
