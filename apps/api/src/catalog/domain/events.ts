import type { DomainEvent } from '@dreamdevops/shared-kernel';

/**
 * The events this module publishes that other modules react to. They are a contract:
 * other modules, and later other services, rely on their names and fields, so a change
 * must stay compatible or come with a new event version.
 */
export interface ApplicationRegisteredPayload {
  readonly applicationId: string;
  readonly name: string;
  readonly slug: string;
  /** The application type's key, such as restful-service. */
  readonly type: string;
}

export interface ApplicationStatusPayload {
  readonly applicationId: string;
  readonly name: string;
}

export type ApplicationRegistered = DomainEvent<'ApplicationRegistered', ApplicationRegisteredPayload>;
export type ApplicationArchived = DomainEvent<'ApplicationArchived', ApplicationStatusPayload>;
export type ApplicationRestored = DomainEvent<'ApplicationRestored', ApplicationStatusPayload>;
