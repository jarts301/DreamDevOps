import type { Principal } from './access.ts';
import type { CreatedInvitation } from './http.ts';

/** What Identity and access answers for other contexts. */

/** A member of the current company, as other contexts may know them. */
export interface CompanyMember {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: string;
}

export const COMPANY_MEMBERS = Symbol('COMPANY_MEMBERS');

/**
 * Who belongs to the current company now. Someone removed from the company isn't found,
 * so contexts that reach people, such as Alerts, ask here just before they do, rather
 * than keeping addresses of their own.
 */
export interface CompanyMembers {
  /** Every member, by name. */
  list(): Promise<CompanyMember[]>;
  /** Those of these users who are members now. Anyone else is left out. */
  find(userIds: readonly string[]): Promise<CompanyMember[]>;
}

export type { CreatedInvitation } from './http.ts';

export const FIRST_ADMIN_INVITATIONS = Symbol('FIRST_ADMIN_INVITATIONS');

/**
 * Invites a new company's first Company Admin. Tenancy asks for it once it has made the
 * company, in the new company's context. It only works while the company has no members,
 * so it can't become a way into a company's data.
 */
export interface FirstAdminInvitations {
  inviteFirstAdmin(actor: Principal, email: string): Promise<CreatedInvitation>;
}
