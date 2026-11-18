/**
 * Identity and access's HTTP API, as the dashboard sees it. Like every http.ts in the
 * contracts, it holds only types and plain values, with no imports beyond other http.ts
 * files, so a browser app can use it.
 */

/** A company role someone can be given, with the permissions it grants. */
export interface RoleView {
  readonly key: string;
  readonly name: string;
  readonly permissions: readonly string[];
}

export interface MemberView {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
  readonly joinedAt: string;
}

/** An invitation not yet accepted, revoked or expired. */
export interface InvitationView {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** An invitation just made. */
export interface CreatedInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  /** Shown once, and sent in the email. Only its hash is kept. */
  readonly token: string;
  readonly expiresAt: string;
}

/** An invitation just made, and whether the API emailed its link. */
export interface SentInvitation extends CreatedInvitation {
  readonly emailSent: boolean;
}

export interface AcceptedInvitation {
  readonly companyId: string;
  readonly role: string;
}

export interface Membership {
  readonly companyId: string;
  readonly companyName: string;
  readonly role: string;
}

/** Who is signed in, and what they may do in the company they act for. */
export interface CurrentUser {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly companyId: string | null;
  readonly companyName: string | null;
  readonly role: string | null;
  readonly permissions: readonly string[];
  readonly memberships: readonly Membership[];
}

/** Where the browser goes to end the login provider's session too, if it has one. */
export interface SignedOut {
  readonly logoutUrl: string | null;
}
