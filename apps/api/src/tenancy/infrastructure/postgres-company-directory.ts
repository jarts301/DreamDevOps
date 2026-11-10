import type { Pool } from 'pg';
import type { CompanyDirectory, CompanyRecord } from '../application/company-directory.ts';

const SELECT_COMPANIES = 'SELECT id, name, slug, status FROM tenancy.companies';

/**
 * Reads the company register. It's platform data, not company data, so it isn't limited
 * by row-level security and needs no company context.
 */
export class PostgresCompanyDirectory implements CompanyDirectory {
  readonly #pool: Pick<Pool, 'query'>;

  constructor(pool: Pick<Pool, 'query'>) {
    this.#pool = pool;
  }

  async find(companyId: string): Promise<CompanyRecord | null> {
    const { rows } = await this.#pool.query<CompanyRecord>(`${SELECT_COMPANIES} WHERE id = $1`, [companyId]);
    return rows[0] ?? null;
  }

  async findBySlug(slug: string): Promise<CompanyRecord | null> {
    const { rows } = await this.#pool.query<CompanyRecord>(`${SELECT_COMPANIES} WHERE slug = $1`, [slug]);
    return rows[0] ?? null;
  }

  async all(): Promise<CompanyRecord[]> {
    const { rows } = await this.#pool.query<CompanyRecord>(`${SELECT_COMPANIES} ORDER BY lower(name)`);
    return rows;
  }
}
