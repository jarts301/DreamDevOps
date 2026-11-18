import { PostgresSession, type TenantDatabase, transactional } from '@dreamdevops/shared-kernel/postgres';
import type { ListedCompany, ResourceStep, StoredCompany, TenancySession, TenancyStore } from '../application/ports.ts';
import type { CompanyStatus } from '../domain/company.ts';

/** The company register and each company's resources, in the tenancy schema. */
export function postgresTenancyStore(database: TenantDatabase): TenancyStore {
  return transactional(database, (tx) => new PostgresTenancySession(tx));
}

class PostgresTenancySession extends PostgresSession implements TenancySession {
  async listCompanies(): Promise<ListedCompany[]> {
    const { rows } = await this.tx.query<{
      id: string;
      name: string;
      slug: string;
      status: CompanyStatus;
      created_at: Date;
      provisioning_error: string | null;
    }>(
      `SELECT c.id, c.name, c.slug, c.status, c.created_at,
              (SELECT r.last_error FROM tenancy.company_resources r
               WHERE r.company_id = c.id AND r.status = 'failed' LIMIT 1) AS provisioning_error
       FROM tenancy.companies c
       ORDER BY lower(c.name)`,
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      createdAt: row.created_at,
      provisioningError: row.provisioning_error,
    }));
  }

  async lockCompany(companyId: string): Promise<StoredCompany | null> {
    const { rows } = await this.tx.query<StoredCompany>('SELECT name, slug, status FROM tenancy.companies WHERE id = $1 FOR UPDATE', [
      companyId,
    ]);
    return rows[0] ?? null;
  }

  async isNameTaken(name: string, exceptId: string | null): Promise<boolean> {
    const { rows } = await this.tx.query('SELECT 1 FROM tenancy.companies WHERE lower(name) = lower($1) AND id <> $2', [
      name,
      exceptId ?? '00000000-0000-0000-0000-000000000000',
    ]);
    return rows.length > 0;
  }

  async isSlugTaken(slug: string): Promise<boolean> {
    const { rows } = await this.tx.query('SELECT 1 FROM tenancy.companies WHERE slug = $1', [slug]);
    return rows.length > 0;
  }

  async addCompany(company: { readonly id: string; readonly name: string; readonly slug: string; readonly createdBy: string }): Promise<Date> {
    const { rows } = await this.tx.query<{ created_at: Date }>(
      `INSERT INTO tenancy.companies (id, name, slug, status, created_by)
       VALUES ($1, $2, $3, 'provisioning', $4)
       RETURNING created_at`,
      [company.id, company.name, company.slug, company.createdBy],
    );
    return rows[0]!.created_at;
  }

  async rename(companyId: string, name: string): Promise<void> {
    await this.tx.query('UPDATE tenancy.companies SET name = $2, updated_at = now() WHERE id = $1', [companyId, name]);
  }

  async suspend(companyId: string): Promise<void> {
    await this.tx.query("UPDATE tenancy.companies SET status = 'suspended', suspended_at = now(), updated_at = now() WHERE id = $1", [
      companyId,
    ]);
  }

  async reactivate(companyId: string): Promise<void> {
    await this.tx.query(
      "UPDATE tenancy.companies SET status = 'provisioning', suspended_at = NULL, updated_at = now() WHERE id = $1",
      [companyId],
    );
  }

  async setStatus(companyId: string, status: CompanyStatus): Promise<void> {
    await this.tx.query('UPDATE tenancy.companies SET status = $2, updated_at = now() WHERE id = $1', [companyId, status]);
  }

  async resetResources(companyId: string): Promise<void> {
    await this.tx.query(
      "UPDATE tenancy.company_resources SET attempts = 0, status = 'pending', updated_at = now() WHERE company_id = $1",
      [companyId],
    );
  }

  async claimResource(companyId: string, kind: string, seconds: number): Promise<boolean> {
    await this.tx.query(
      `INSERT INTO tenancy.company_resources (company_id, kind, status) VALUES ($1, $2, 'pending')
       ON CONFLICT (company_id, kind) DO NOTHING`,
      [companyId, kind],
    );
    const { rowCount } = await this.tx.query(
      `UPDATE tenancy.company_resources SET claimed_until = now() + make_interval(secs => $3)
       WHERE company_id = $1 AND kind = $2 AND (claimed_until IS NULL OR claimed_until < now())`,
      [companyId, kind, seconds],
    );
    return rowCount === 1;
  }

  async renewClaim(companyId: string, kind: string, seconds: number): Promise<void> {
    await this.tx.query(
      `UPDATE tenancy.company_resources SET claimed_until = now() + make_interval(secs => $3)
       WHERE company_id = $1 AND kind = $2`,
      [companyId, kind, seconds],
    );
  }

  async recordStep(companyId: string, kind: string, step: ResourceStep): Promise<number> {
    const { rows } = await this.tx.query<{ attempts: number }>(
      `INSERT INTO tenancy.company_resources (company_id, kind, status, external_id, attempts, last_error)
       VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'failed' THEN 1 ELSE 0 END, $5)
       ON CONFLICT (company_id, kind) DO UPDATE SET
         status = EXCLUDED.status,
         external_id = coalesce(EXCLUDED.external_id, tenancy.company_resources.external_id),
         attempts = CASE WHEN EXCLUDED.status = 'failed' THEN tenancy.company_resources.attempts + 1 ELSE 0 END,
         last_error = EXCLUDED.last_error,
         claimed_until = NULL,
         updated_at = now()
       RETURNING attempts`,
      [companyId, kind, step.status, step.externalId, step.error],
    );
    return rows[0]!.attempts;
  }
}
