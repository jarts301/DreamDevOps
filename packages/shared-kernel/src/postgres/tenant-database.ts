import type { Pool, PoolClient } from 'pg';
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
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
