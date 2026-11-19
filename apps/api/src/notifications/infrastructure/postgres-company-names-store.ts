import { currentCompanyId } from '@dreamdevops/shared-kernel';
import { PostgresSession, type TenantDatabase, transactional } from '@dreamdevops/shared-kernel/postgres';
import type { CompanyNamesSession, CompanyNamesStore } from '../application/ports.ts';

/** Each company's name, in the notification schema, as Tenancy's events gave it. */
export function postgresCompanyNamesStore(database: TenantDatabase): CompanyNamesStore {
  return transactional(database, (tx) => new PostgresCompanyNamesSession(tx), { role: 'dreamdevops_notification' });
}

class PostgresCompanyNamesSession extends PostgresSession implements CompanyNamesSession {
  async name(): Promise<string | null> {
    const { rows } = await this.tx.query<{ name: string }>('SELECT name FROM notification.companies WHERE company_id = $1', [
      currentCompanyId(),
    ]);
    return rows[0]?.name ?? null;
  }

  async named(name: string, at: Date): Promise<void> {
    // Events can arrive late or twice, so a name only replaces one given before it.
    await this.tx.query(
      `INSERT INTO notification.companies (company_id, name, named_at) VALUES ($1, $2, $3)
       ON CONFLICT (company_id) DO UPDATE SET name = excluded.name, named_at = excluded.named_at
       WHERE notification.companies.named_at <= excluded.named_at`,
      [currentCompanyId(), name, at],
    );
  }

  async rememberIfUnknown(name: string): Promise<void> {
    // As old as can be, so any event about the company, however late, wins over it.
    await this.tx.query(
      `INSERT INTO notification.companies (company_id, name, named_at) VALUES ($1, $2, '-infinity')
       ON CONFLICT (company_id) DO NOTHING`,
      [currentCompanyId(), name],
    );
  }
}
