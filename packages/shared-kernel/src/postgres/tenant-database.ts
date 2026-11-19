import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

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
 * The database role a context's work runs as. Each context has its own, with rights on its
 * own schemas only, so a query that strays into another context's tables is refused by the
 * database itself. The pool's login is a member of every context's role, without inheriting
 * their rights, so it can switch to one but holds none of them itself.
 */
export interface DatabaseRole {
  /** Such as dreamdevops_catalog. */
  readonly role: string;
}

/** Runs one query at a time, as the pg pool does. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

/** Role names are put into SQL as they are, so only plain ones are allowed. */
const ROLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Opens transactions in which row-level security sees only the current company, as a
 * context's own role. The settings are local to the transaction, so they can't leak to the
 * next user of a pooled connection. Use a pool that logs in as the dreamdevops_app role.
 */
export class TenantDatabase {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Runs the work in one transaction, for the current company, as the context's role when one
   * is given. Outside a company's context, it rejects, as everything here does, never throws.
   */
  async transaction<T>(work: (transaction: TenantTransaction) => Promise<T>, options: Partial<DatabaseRole> = {}): Promise<T> {
    return this.#run(currentCompanyId(), options.role, work);
  }

  /**
   * Queries that belong to no one company, such as finding who a webhook is for, or one
   * person's access across companies. Each runs in a transaction of its own, as the context's
   * role, with no company set, so row-level security shows no company's rows: only tables and
   * functions made to be read across companies answer.
   */
  acrossCompanies(options: DatabaseRole): Queryable {
    return {
      query: <R extends QueryResultRow>(text: string, values?: unknown[]) =>
        this.#run(null, options.role, (tx) => tx.query<R>(text, values)),
    };
  }

  async #run<T>(companyId: string | null, role: string | undefined, work: (transaction: TenantTransaction) => Promise<T>): Promise<T> {
    if (role !== undefined && !ROLE_NAME.test(role)) {
      throw new Error(`"${role}" is not a database role name.`);
    }
    const client = await this.#pool.connect();
    // A connection whose rollback failed may be broken, so it's closed rather than reused.
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      if (role !== undefined) {
        await client.query(`SET LOCAL ROLE ${role}`);
      }
      if (companyId !== null) {
        await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
      }
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
