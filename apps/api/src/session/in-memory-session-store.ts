import type { Principal } from '../identity/principal.ts';
import type { SessionLifetime, SessionStore } from './session-store.ts';

interface StoredSession {
  readonly principal: Principal;
  readonly expiresAt: number;
  idleExpiresAt: number;
}

/** A fake SessionStore for fast tests. The same contract tests run against this and PostgreSQL. */
export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, StoredSession>();

  async create(idHash: string, principal: Principal, lifetime: SessionLifetime): Promise<void> {
    const now = Date.now();
    this.#sessions.set(idHash, {
      principal,
      expiresAt: now + lifetime.absoluteMs,
      idleExpiresAt: now + lifetime.idleMs,
    });
  }

  async touch(idHash: string, idleMs: number): Promise<Principal | null> {
    const session = this.#sessions.get(idHash);
    const now = Date.now();
    if (session === undefined || session.expiresAt <= now || session.idleExpiresAt <= now) {
      return null;
    }
    session.idleExpiresAt = Math.min(session.expiresAt, now + idleMs);
    return session.principal;
  }

  async delete(idHash: string): Promise<void> {
    this.#sessions.delete(idHash);
  }
}
