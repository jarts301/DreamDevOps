import type { Authentication, Authenticator as PublishedAuthenticator } from '@dreamdevops/contracts/identity-access/services';
import { requiresMfa, toPrincipal } from '../domain/access.ts';
import type { UserDirectory } from './ports.ts';
import { hashSessionId, type SessionStore } from './sessions.ts';

/**
 * Finds who a request is from, by its session, for the platform's guards. Permissions are
 * read each time, so taking someone's access away takes effect on their next request.
 */
export class Authenticator implements PublishedAuthenticator {
  readonly #sessions: SessionStore;
  readonly #directory: UserDirectory;
  readonly #idleMs: number;

  constructor(sessions: SessionStore, directory: UserDirectory, options: { readonly idleMs: number }) {
    this.#sessions = sessions;
    this.#directory = directory;
    this.#idleMs = options.idleMs;
  }

  async authenticate(sessionId: string): Promise<Authentication | null> {
    const sessionIdHash = hashSessionId(sessionId);
    const session = await this.#sessions.touch(sessionIdHash, this.#idleMs);
    if (session === null) {
      return null;
    }
    const access = await this.#directory.loadAccess(session.userId);
    // Someone who needs a second factor but signed in without one, such as a member just
    // made a Tech Lead, counts as signed out, so they sign in again with one.
    if (access === null || (requiresMfa(access) && session.mfa !== true)) {
      return null;
    }
    return { principal: toPrincipal(access, session.chosenCompanyId), session, sessionIdHash };
  }
}
