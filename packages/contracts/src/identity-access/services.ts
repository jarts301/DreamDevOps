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

/** Who is signed in, as their login session keeps it. Permissions are read on each request, so they're never stale. */
export interface SessionData {
  readonly userId: string;
  readonly chosenCompanyId: string | null;
  /** Kept only to end the login provider's session at logout. */
  readonly idToken: string | null;
  /** Whether the login used a second factor. Sessions from before this was kept have none. */
  readonly mfa?: boolean;
}

/** A signed-in request: who is acting, and the session that says so. */
export interface Authentication {
  readonly principal: Principal;
  readonly session: SessionData;
  /** The hash of the session's ID, which is how the session is kept, never the ID itself. */
  readonly sessionIdHash: string;
}

export const AUTHENTICATOR = Symbol('AUTHENTICATOR');

/**
 * Finds who a request is from, by its session cookie. The platform's guards ask here on every
 * request, so they need nothing of Identity and access but this. Login sessions are Identity's:
 * it keeps them, ends them when they expire, and decides who counts as signed in.
 */
export interface Authenticator {
  /**
   * Null when the session is unknown or expired, or when the person needs a second factor
   * they didn't sign in with, such as a member just made a Tech Lead: they count as signed
   * out, so they sign in again with one. Using a session extends its idle time.
   */
  authenticate(sessionId: string): Promise<Authentication | null>;
}
