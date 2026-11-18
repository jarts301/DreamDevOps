import { PostgresSession, type TenantDatabase, transactional } from '@dreamdevops/shared-kernel/postgres';
import type { ChosenEdition, EditionsSession, EditionsStore } from '../application/ports.ts';
import type { Edition } from '../domain/features.ts';

/** Each company's edition, in the editions schema. */
export function postgresEditionsStore(database: TenantDatabase): EditionsStore {
  return transactional(database, (tx) => new PostgresEditionsSession(tx));
}

class PostgresEditionsSession extends PostgresSession implements EditionsSession {
  async editionOf(companyId: string): Promise<Edition> {
    const { rows } = await this.tx.query<{ edition: Edition }>('SELECT edition FROM editions.company_editions WHERE company_id = $1', [
      companyId,
    ]);
    return rows[0]?.edition ?? 'community';
  }

  async lockCompany(companyId: string): Promise<void> {
    await this.tx.query("SELECT pg_advisory_xact_lock(hashtextextended('editions:' || $1, 0))", [companyId]);
  }

  async setEdition(companyId: string, edition: Edition, changedBy: string): Promise<void> {
    await this.tx.query(
      `INSERT INTO editions.company_editions (company_id, edition, changed_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id) DO UPDATE
         SET edition = EXCLUDED.edition, changed_by = EXCLUDED.changed_by, changed_at = now()`,
      [companyId, edition, changedBy],
    );
  }

  async chosen(): Promise<ChosenEdition[]> {
    const { rows } = await this.tx.query<{ company_id: string; edition: Edition; changed_at: Date }>(
      'SELECT company_id, edition, changed_at FROM editions.company_editions',
    );
    return rows.map((row) => ({ companyId: row.company_id, edition: row.edition, changedAt: row.changed_at }));
  }
}
