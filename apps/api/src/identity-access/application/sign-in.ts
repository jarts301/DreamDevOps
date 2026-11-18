import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Principal } from '@dreamdevops/contracts/identity-access/access';
import type { SignedOut } from '@dreamdevops/contracts/identity-access/http';
import { hashSessionId, newSessionId, type SessionData, type SessionLifetime, type SessionStore } from '../../session/session-store.ts';
import { requiresMfa } from '../domain/access.ts';
import { AccessError } from '../domain/errors.ts';
import type { IdentityProvider, UserDirectory } from './ports.ts';

export interface SignInOptions {
  /** Where browsers reach the API, for the login provider's callback. */
  readonly publicUrl: string;
  /** Where people go once they're signed in or out. */
  readonly dashboardUrl: string;
  readonly session: SessionLifetime;
}

/**
 * A login just started: where to send the browser, and what the browser keeps meanwhile,
 * in a cookie only the API reads, to prove the login provider's answer is for this login.
 */
export interface StartedLogin {
  readonly authorizationUrl: string;
  readonly attempt: string;
}

/**
 * How a login ended: with a new session, whose ID goes to the browser, or with the login
 * started again, to ask for the second factor the person's role needs.
 */
export type FinishedLogin = { readonly sessionId: string } | { readonly stepUp: string };

/**
 * Signing in and out through the login provider, with the authorization code flow, a
 * nonce and PKCE. The login provider's tokens stay here; the browser only ever holds an
 * opaque session ID.
 */
export class SignIn {
  readonly #provider: IdentityProvider;
  readonly #directory: UserDirectory;
  readonly #sessions: SessionStore;
  readonly #options: SignInOptions;

  constructor(provider: IdentityProvider, directory: UserDirectory, sessions: SessionStore, options: SignInOptions) {
    this.#provider = provider;
    this.#directory = directory;
    this.#sessions = sessions;
    this.#options = options;
  }

  /** Starts a login, asking for a second factor when told to. A hint keeps the login provider on the same person. */
  async start(loginHint: unknown, mfa: unknown): Promise<StartedLogin> {
    const requireMfa = mfa === '1';
    const state = randomValue();
    const nonce = randomValue();
    const codeVerifier = randomValue();
    const authorizationUrl = await this.#provider.authorizationUrl({
      state,
      nonce,
      codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      redirectUri: this.#callbackUrl(),
      ...(typeof loginHint === 'string' && { loginHint }),
      requireMfa,
    });
    return { authorizationUrl, attempt: `${state}.${nonce}.${codeVerifier}.${requireMfa ? '1' : '0'}` };
  }

  /**
   * Ends a login with the login provider's answer. Admins and Tech Leads need a second
   * factor: without one, the login starts again and asks for it, and the login provider
   * only asks for the one-time code, not the password again.
   */
  async finish(input: {
    readonly state: unknown;
    readonly attempt: string | undefined;
    /** The callback's path and query, as the login provider sent the browser back. */
    readonly callbackPath: string;
    /** The session the browser had, if any, which a new login replaces. */
    readonly previousSessionId: string | undefined;
  }): Promise<FinishedLogin> {
    const [expectedState, nonce, codeVerifier, mfaRequested] = (input.attempt ?? '').split('.');
    if (typeof input.state !== 'string' || !expectedState || !nonce || !codeVerifier || !sameText(input.state, expectedState)) {
      throw new AccessError('invalid', 'This login attempt is not valid. Start again.');
    }
    const identity = await this.#provider.exchangeCode({
      callbackUrl: new URL(`${this.#options.publicUrl}${input.callbackPath}`),
      state: expectedState,
      nonce,
      codeVerifier,
    });
    if (identity === null) {
      throw new AccessError('unauthorized', 'The login did not succeed.');
    }
    const userId = await this.#directory.recordLogin(identity);

    const access = await this.#directory.loadAccess(userId);
    if (access !== null && requiresMfa(access) && !identity.mfa) {
      if (mfaRequested === '1') {
        throw new AccessError('forbidden', 'Your login provider did not confirm a second factor.');
      }
      const stepUp = new URL(`${this.#options.publicUrl}/api/v1/auth/login`);
      stepUp.searchParams.set('mfa', '1');
      // The login provider still has its own session, and the hint keeps it on the same person.
      stepUp.searchParams.set('login_hint', identity.email);
      return { stepUp: stepUp.toString() };
    }

    // A new session ID at every login stops an attacker from planting one in advance.
    if (input.previousSessionId !== undefined) {
      await this.#sessions.delete(hashSessionId(input.previousSessionId));
    }
    const sessionId = newSessionId();
    await this.#sessions.create(
      hashSessionId(sessionId),
      { userId, chosenCompanyId: null, idToken: identity.idToken, mfa: identity.mfa },
      this.#options.session,
    );
    return { sessionId };
  }

  /** Ends the session, and says where the browser goes to end the login provider's session too. */
  async signOut(sessionIdHash: string, idToken: string | null): Promise<SignedOut> {
    await this.#sessions.delete(sessionIdHash);
    return { logoutUrl: await this.#provider.logoutUrl({ idToken, postLogoutRedirectUri: this.#options.dashboardUrl }) };
  }

  /** Chooses which of the person's companies the session acts for. */
  async chooseCompany(principal: Principal, session: { readonly idHash: string; readonly data: SessionData }, companyId: unknown): Promise<void> {
    if (typeof companyId !== 'string' || !principal.memberships.some((membership) => membership.companyId === companyId)) {
      throw new AccessError('forbidden', 'You are not a member of this company.');
    }
    await this.#sessions.update(session.idHash, { ...session.data, chosenCompanyId: companyId });
  }

  #callbackUrl(): string {
    return `${this.#options.publicUrl}/api/v1/auth/callback`;
  }
}

function randomValue(): string {
  return randomBytes(32).toString('base64url');
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
