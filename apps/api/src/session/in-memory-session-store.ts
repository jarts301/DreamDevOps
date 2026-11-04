import type { SessionData, SessionLifetime, SessionStore } from './session-store.ts';

interface StoredSession {
  data: SessionData;
  readonly expiresAt: number;
  idleExpiresAt: number;
}

/** A fake SessionStore for fast tests. The same contract tests run against this and PostgreSQL. */
export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, StoredSession>();

  async create(idHash: string, data: SessionData, lifetime: SessionLifetime): Promise<void> {
    const now = Date.now();
    this.#sessions.set(idHash, {
      data,
      expiresAt: now + lifetime.absoluteMs,
      idleExpiresAt: now + lifetime.idleMs,
    });
  }

  async touch(idHash: string, idleMs: number): Promise<SessionData | null> {
    const session = this.#sessions.get(idHash);
    const now = Date.now();
    if (session === undefined || session.expiresAt <= now || session.idleExpiresAt <= now) {
      return null;
    }
    session.idleExpiresAt = Math.min(session.expiresAt, now + idleMs);
    return session.data;
  }

  async update(idHash: string, data: SessionData): Promise<void> {
    const session = this.#sessions.get(idHash);
    if (session !== undefined) {
      session.data = data;
    }
  }

  async delete(idHash: string): Promise<void> {
    this.#sessions.delete(idHash);
  }
}
