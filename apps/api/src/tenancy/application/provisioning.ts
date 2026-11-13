import { createDomainEvent, currentCompanyId, describeError } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { CompanyStatus } from '../domain/company.ts';
import { type GitProvider, PermanentProvisioningError } from './ports.ts';

/** The events that make a company's resources need checking. */
export const PROVISIONING_TRIGGERS = ['CompanyCreated', 'CompanyRenamed', 'CompanyProvisioningRequested'] as const;

const GIT_ORGANIZATION = 'git-organization';

export interface ProvisioningOptions {
  /** Attempts before the company is marked as failed, so a platform admin can step in. */
  readonly maxAttempts: number;
}

interface CompanyRow {
  name: string;
  slug: string;
  status: CompanyStatus;
}

/**
 * The provisioning saga. It brings a company's resources in line with the company,
 * one step at a time, and records each step, so a retry resumes where it stopped.
 * Every step is safe to repeat, because events can arrive more than once.
 */
export class ProvisioningSaga {
  readonly #database: TenantDatabase;
  readonly #git: GitProvider;
  readonly #options: ProvisioningOptions;

  constructor(database: TenantDatabase, git: GitProvider, options: ProvisioningOptions) {
    this.#database = database;
    this.#git = git;
    this.#options = options;
  }

  /** Runs in the company's context. Throws to have the job retried later. */
  async reconcile(): Promise<void> {
    const failure = await this.#database.transaction(async (tx) => {
      // Locking the company stops two jobs for it from working at the same time.
      const { rows } = await tx.query<CompanyRow>(
        'SELECT name, slug, status FROM tenancy.companies WHERE id = $1 FOR UPDATE',
        [currentCompanyId()],
      );
      const company = rows[0];
      if (company === undefined || company.status === 'suspended') {
        return null;
      }

      try {
        const externalId = await this.#git.ensureOrganization({
          name: company.slug,
          displayName: company.name,
          companyId: currentCompanyId(),
        });
        await recordStep(tx, { status: 'ready', externalId, error: null });
      } catch (error) {
        const attempts = await recordStep(tx, { status: 'failed', externalId: null, error: describeError(error) });
        if (error instanceof PermanentProvisioningError || attempts >= this.#options.maxAttempts) {
          await setStatus(tx, company, 'provisioning-failed', 'CompanyProvisioningFailed', { reason: describeError(error) });
          return null;
        }
        return error;
      }

      await setStatus(tx, company, 'active', 'CompanyProvisioned', {});
      return null;
    });

    // Thrown after the transaction commits, so the failed attempt stays recorded.
    if (failure !== null) {
      throw failure;
    }
  }
}

async function recordStep(
  tx: TenantTransaction,
  step: { status: 'ready' | 'failed'; externalId: string | null; error: string | null },
): Promise<number> {
  const { rows } = await tx.query<{ attempts: number }>(
    `INSERT INTO tenancy.company_resources (company_id, kind, status, external_id, attempts, last_error)
     VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'failed' THEN 1 ELSE 0 END, $5)
     ON CONFLICT (company_id, kind) DO UPDATE SET
       status = EXCLUDED.status,
       external_id = coalesce(EXCLUDED.external_id, tenancy.company_resources.external_id),
       attempts = CASE WHEN EXCLUDED.status = 'failed' THEN tenancy.company_resources.attempts + 1 ELSE 0 END,
       last_error = EXCLUDED.last_error,
       updated_at = now()
     RETURNING attempts`,
    [currentCompanyId(), GIT_ORGANIZATION, step.status, step.externalId, step.error],
  );
  return rows[0]!.attempts;
}

async function setStatus(
  tx: TenantTransaction,
  company: CompanyRow,
  status: CompanyStatus,
  eventType: string,
  payload: object,
): Promise<void> {
  if (company.status === status) {
    return;
  }
  await tx.query('UPDATE tenancy.companies SET status = $2, updated_at = now() WHERE id = $1', [
    currentCompanyId(),
    status,
  ]);
  await appendToOutbox(tx, [createDomainEvent({ eventType, companyId: currentCompanyId(), payload })]);
}
