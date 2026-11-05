import type pg from 'pg';

/**
 * Registers an active company directly, as the table owner. For tests about what
 * happens inside a company, so they don't wait for provisioning or see its events.
 */
export async function insertActiveCompany(ownerPool: pg.Pool, companyId: string): Promise<void> {
  await ownerPool.query(`INSERT INTO tenancy.companies (id, slug, name, status) VALUES ($1, $2, $3, 'active')`, [
    companyId,
    `company-${companyId.replaceAll('-', '')}`,
    `Company ${companyId.slice(0, 8)}`,
  ]);
}
