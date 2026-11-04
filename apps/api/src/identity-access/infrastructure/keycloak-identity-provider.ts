import * as client from 'openid-client';
import type {
  AuthorizationRequest,
  CodeExchange,
  ExternalIdentity,
  IdentityProvider,
  LogoutRequest,
} from '../application/ports.ts';

export interface KeycloakOptions {
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

const PLATFORM_ADMIN_ROLE = 'platform-admin';

/** The Keycloak adapter. Keycloak's concepts stay inside this file. */
export class KeycloakIdentityProvider implements IdentityProvider {
  readonly #options: KeycloakOptions;
  #configuration: Promise<client.Configuration> | undefined;

  constructor(options: KeycloakOptions) {
    this.#options = options;
  }

  async authorizationUrl(request: AuthorizationRequest): Promise<string> {
    const configuration = await this.#configure();
    return client
      .buildAuthorizationUrl(configuration, {
        redirect_uri: request.redirectUri,
        scope: 'openid email profile',
        state: request.state,
        nonce: request.nonce,
        code_challenge: request.codeChallenge,
        code_challenge_method: 'S256',
        ...(request.loginHint !== undefined && { login_hint: request.loginHint }),
      })
      .toString();
  }

  async exchangeCode(exchange: CodeExchange): Promise<ExternalIdentity | null> {
    const configuration = await this.#configure();
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(configuration, exchange.callbackUrl, {
        pkceCodeVerifier: exchange.codeVerifier,
        expectedState: exchange.state,
        expectedNonce: exchange.nonce,
        idTokenExpected: true,
      });
    } catch (error) {
      // The provider or its response refused the login. Network failures still surface.
      if (error instanceof client.AuthorizationResponseError || error instanceof client.ResponseBodyError) {
        return null;
      }
      if (error instanceof client.ClientError) {
        return null;
      }
      throw error;
    }

    const claims = tokens.claims();
    if (claims === undefined || typeof claims.email !== 'string' || claims.email === '') {
      return null;
    }
    const roles = Array.isArray(claims.realm_roles) ? claims.realm_roles : [];
    return {
      subject: claims.sub,
      email: claims.email.toLowerCase(),
      emailVerified: claims.email_verified === true,
      displayName: typeof claims.name === 'string' && claims.name !== '' ? claims.name : claims.email,
      platformAdmin: roles.includes(PLATFORM_ADMIN_ROLE),
      idToken: tokens.id_token ?? null,
    };
  }

  async logoutUrl(request: LogoutRequest): Promise<string | null> {
    const configuration = await this.#configure();
    return client
      .buildEndSessionUrl(configuration, {
        post_logout_redirect_uri: request.postLogoutRedirectUri,
        ...(request.idToken !== null && { id_token_hint: request.idToken }),
      })
      .toString();
  }

  /** Connects on first use, so the API can start before Keycloak and recover if it was down. */
  #configure(): Promise<client.Configuration> {
    this.#configuration ??= this.#discover().catch((error: unknown) => {
      this.#configuration = undefined;
      throw error;
    });
    return this.#configuration;
  }

  #discover(): Promise<client.Configuration> {
    const issuer = new URL(this.#options.issuerUrl);
    return client.discovery(
      issuer,
      this.#options.clientId,
      this.#options.clientSecret,
      undefined,
      // Only an http:// issuer allows this, and configuration refuses one in production.
      issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : {},
    );
  }
}
