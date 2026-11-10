import type { DomainEvent } from '@dreamdevops/shared-kernel';

/**
 * The events this module publishes that other modules react to. They are a contract:
 * other modules, and later other services, rely on their names and fields, so a change
 * must stay compatible or come with a new event version.
 */
export interface RepositoryRequestedPayload {
  readonly applicationId: string;
}

export interface RepositoryCreatedPayload {
  readonly applicationId: string;
  readonly name: string;
  /** Its full name in the Git tool, such as acme/billing-api. */
  readonly repository: string;
  readonly blueprint: string;
  readonly blueprintVersion: string;
}

export type RepositoryRequested = DomainEvent<'RepositoryRequested', RepositoryRequestedPayload>;
export type RepositoryCreated = DomainEvent<'RepositoryCreated', RepositoryCreatedPayload>;
