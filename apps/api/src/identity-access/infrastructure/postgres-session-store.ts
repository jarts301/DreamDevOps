import type { Queryable } from '@dreamdevops/shared-kernel/postgres';
import type { SessionData, SessionLifetime, SessionStore } from '../application/sessions.ts';

/**
 * Keeps login sessions in the identity schema, through functions, the only access Identity
 * and access's role has to them. A session is found before any company is chosen, so this
 * works across companies, and needs the session's secret hash to find one.
 */
export class PostgresSessionStore implements SessionStore {
  readonly #pool: Queryable;

  constructor(pool: Queryable) {
    this.#pool = pool;
  }

  async create(idHash: string, data: SessionData, lifetime: SessionLifetime): Promise<void> {
    await this.#pool.query('SELECT identity.session_create($1, $2, $3, $4)', [
      idHash,
      data,
      lifetime.absoluteMs,
      lifetime.idleMs,
    ]);
  }

  async touch(idHash: string, idleMs: number): Promise<SessionData | null> {
    const { rows } = await this.#pool.query<{ data: SessionData | null }>('SELECT identity.session_touch($1, $2) AS data', [
      idHash,
      idleMs,
    ]);
    return rows[0]?.data ?? null;
  }

  async update(idHash: string, data: SessionData): Promise<void> {
    await this.#pool.query('SELECT identity.session_update($1, $2)', [idHash, data]);
  }

  async delete(idHash: string): Promise<void> {
    await this.#pool.query('SELECT identity.session_delete($1)', [idHash]);
  }
}
