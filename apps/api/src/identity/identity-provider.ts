import type { Principal } from './principal.ts';

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');

export interface AuthorizationRequest {
  readonly state: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly loginHint?: string;
}

export interface CodeExchange {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

/**
 * The login provider, shaped around the OpenID Connect authorization code flow with
 * PKCE. Identity and Access will add the Keycloak implementation.
 */
export interface IdentityProvider {
  authorizationUrl(request: AuthorizationRequest): string;
  /** Returns the signed-in user, or null if the code is not valid. */
  exchangeCode(exchange: CodeExchange): Promise<Principal | null>;
}
