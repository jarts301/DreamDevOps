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
