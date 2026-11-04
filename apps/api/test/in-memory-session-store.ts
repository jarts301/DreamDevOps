import type { SessionData, SessionLifetime, SessionStore } from '../src/session/session-store.ts';

interface StoredSession {
  data: SessionData;
  expiresAt: number;
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

  /** Test control: moves a limit into the past, so tests don't wait on a clock. */
  expire(idHash: string, limit: 'idle' | 'absolute'): void {
    const session = this.#sessions.get(idHash)!;
    if (limit === 'idle') {
      session.idleExpiresAt = 0;
    } else {
      session.expiresAt = 0;
    }
  }

  expiryTimes(idHash: string): { idle: number; absolute: number } {
    const session = this.#sessions.get(idHash)!;
    return { idle: session.idleExpiresAt, absolute: session.expiresAt };
  }
}
