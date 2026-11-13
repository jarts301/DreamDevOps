import type { DomainEvent } from '@dreamdevops/shared-kernel';

/**
 * The events of this module that other modules react to. They're a contract, so their
 * names and fields must stay compatible, or come with a new event version. Payloads hold
 * IDs and roles, never email addresses or tokens.
 */
export interface MemberRemovedPayload {
  readonly userId: string;
  /** The role they had. */
  readonly role: string;
  readonly removedBy: string;
}

export type MemberRemoved = DomainEvent<'MemberRemoved', MemberRemovedPayload>;
