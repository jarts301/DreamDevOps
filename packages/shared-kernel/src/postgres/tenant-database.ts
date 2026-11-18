import type { Pool, PoolClient } from 'pg';

/**
 * Rolls back a failed transaction. Returns the error if that failed too, which means the
 * connection may be broken and must not go back to the pool; the original error is what
 * the caller sees.
 */
export async function rollBack(client: Pick<PoolClient, 'query'>): Promise<Error | undefined> {
  try {
    await client.query('ROLLBACK');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error('The rollback failed.');
  }
}
import { currentCompanyId } from '../application/tenant-context.ts';

/** A connection inside a transaction scoped to the current company. */
export type TenantTransaction = Pick<PoolClient, 'query'>;

/**
 * Opens transactions in which row-level security sees only the current company.
 * The setting is local to the transaction, so it can't leak to the next user of
 * a pooled connection. Use a pool that logs in as the dreamdevops_app role.
 */
export class TenantDatabase {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async transaction<T>(work: (transaction: TenantTransaction) => Promise<T>): Promise<T> {
    const companyId = currentCompanyId();
    const client = await this.#pool.connect();
    // A connection whose rollback failed may be broken, so it's closed rather than reused.
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      broken = await rollBack(client);
      throw error;
    } finally {
      client.release(broken);
    }
  }
}
