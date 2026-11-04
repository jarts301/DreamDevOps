import type { Pool } from 'pg';
import type { Principal } from '../identity/principal.ts';
import type { SessionLifetime, SessionStore } from './session-store.ts';

/** Stores sessions through database functions, the only access the application role has. */
export class PostgresSessionStore implements SessionStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async create(idHash: string, principal: Principal, lifetime: SessionLifetime): Promise<void> {
    await this.#pool.query('SELECT api.session_create($1, $2, $3, $4)', [
      idHash,
      principal,
      lifetime.absoluteMs,
      lifetime.idleMs,
    ]);
  }

  async touch(idHash: string, idleMs: number): Promise<Principal | null> {
    const { rows } = await this.#pool.query<{ principal: Principal | null }>(
      'SELECT api.session_touch($1, $2) AS principal',
      [idHash, idleMs],
    );
    return rows[0]?.principal ?? null;
  }

  async delete(idHash: string): Promise<void> {
    await this.#pool.query('SELECT api.session_delete($1)', [idHash]);
  }
}
