import type { EventLog, Transactional } from '@dreamdevops/shared-kernel';
import type { UserAccess } from '../domain/access.ts';

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');
export const USER_DIRECTORY = Symbol('USER_DIRECTORY');

/** A user as the login provider describes them. */
export interface ExternalIdentity {
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName: string;
  readonly platformAdmin: boolean;
  readonly idToken: string | null;
  /** Whether this login used a second factor, such as a one-time code. */
  readonly mfa: boolean;
}

export interface AuthorizationRequest {
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly loginHint?: string;
  /** Asks the login provider for a second factor. */
  readonly requireMfa?: boolean;
}

export interface CodeExchange {
  /** The full address the login provider redirected back to. */
  readonly callbackUrl: URL;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

export interface LogoutRequest {
  readonly idToken: string | null;
  readonly postLogoutRedirectUri: string;
}

/** The login provider, shaped around OpenID Connect's code flow with PKCE. */
export interface IdentityProvider {
  authorizationUrl(request: AuthorizationRequest): Promise<string>;
  /** Returns the signed-in user, or null if the login provider refused the login. */
  exchangeCode(exchange: CodeExchange): Promise<ExternalIdentity | null>;
  /** Where to send the browser to end the provider's own session, if anywhere. */
  logoutUrl(request: LogoutRequest): Promise<string | null>;
}

/** Finds users across companies, which is needed before any company is known. */
export interface UserDirectory {
  /** Creates or updates the user from a login, and returns their ID. */
  recordLogin(identity: ExternalIdentity): Promise<string>;
  loadAccess(userId: string): Promise<UserAccess | null>;
}

/** A role a company member can have, with what it grants. */
export interface CompanyRole {
  readonly key: string;
  readonly name: string;
  readonly permissions: readonly string[];
}

/** A member of the current company. */
export interface StoredMember {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
  readonly joinedAt: Date;
}

/** An invitation not yet accepted, revoked or expired. */
export interface OpenInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface NewInvitation {
  readonly email: string;
  readonly role: string;
  /** Only the token's hash is kept, so the token works only for whoever was given it. */
  readonly tokenHash: string;
  readonly invitedBy: string;
  readonly lifetimeDays: number;
}

/** The current company's members and invitations, in one transaction. */
export interface MembershipSession extends EventLog {
  /** The roles a company member can have, by key. */
  companyRoles(): Promise<CompanyRole[]>;
  isCompanyRole(key: string): Promise<boolean>;
  /** Every member, in the order they joined. */
  members(): Promise<StoredMember[]>;
  /** The members with these IDs, or every member when none are given, by name. */
  membersByName(userIds: readonly string[] | null): Promise<StoredMember[]>;
  hasMembers(): Promise<boolean>;
  hasMemberWithEmail(email: string): Promise<boolean>;
  /** A member's role, locked until the transaction ends, or null if they aren't a member. */
  lockRoleOf(userId: string): Promise<string | null>;
  /** The IDs of the members with a role, locked, so two requests can't each remove the other's last admin. */
  lockMembersWithRole(role: string): Promise<string[]>;
  setRole(userId: string, role: string): Promise<void>;
  removeMember(userId: string): Promise<void>;
  /** Adds a member. False when they're a member already. */
  addMember(companyId: string, userId: string, role: string): Promise<boolean>;
  openInvitations(): Promise<OpenInvitation[]>;
  /** Revokes an invitation nobody accepted yet. False when there's none such. */
  revokeInvitation(id: string): Promise<boolean>;
  /** Revokes an address's expired invitations, which no longer count. */
  revokeExpiredInvitations(email: string): Promise<void>;
  hasOpenInvitation(email: string): Promise<boolean>;
  addInvitation(invitation: NewInvitation): Promise<{ readonly id: string; readonly expiresAt: Date }>;
  /** The usable invitation with this token hash, locked, or null. */
  lockUsableInvitation(tokenHash: string): Promise<{ readonly id: string; readonly email: string; readonly role: string } | null>;
  markAccepted(invitationId: string, userId: string): Promise<void>;
}

export const MEMBERSHIP_STORE = Symbol('MEMBERSHIP_STORE');

export interface MembershipStore extends Transactional<MembershipSession> {
  /**
   * The company an invitation belongs to, found by its token's hash. The person accepting
   * has no company context until this answers, so it needs none.
   */
  invitationCompany(tokenHash: string): Promise<string | null>;
}
