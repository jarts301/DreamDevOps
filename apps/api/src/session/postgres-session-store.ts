import type { Pool } from 'pg';
import type { SessionData, SessionLifetime, SessionStore } from './session-store.ts';

/** Stores sessions through database functions, the only access the application role has. */
export class PostgresSessionStore implements SessionStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async create(idHash: string, data: SessionData, lifetime: SessionLifetime): Promise<void> {
    await this.#pool.query('SELECT api.session_create($1, $2, $3, $4)', [
      idHash,
      data,
      lifetime.absoluteMs,
      lifetime.idleMs,
    ]);
  }

  async touch(idHash: string, idleMs: number): Promise<SessionData | null> {
    const { rows } = await this.#pool.query<{ data: SessionData | null }>('SELECT api.session_touch($1, $2) AS data', [
      idHash,
      idleMs,
    ]);
    return rows[0]?.data ?? null;
  }

  async update(idHash: string, data: SessionData): Promise<void> {
    await this.#pool.query('SELECT api.session_update($1, $2)', [idHash, data]);
  }

  async delete(idHash: string): Promise<void> {
    await this.#pool.query('SELECT api.session_delete($1)', [idHash]);
  }
}
