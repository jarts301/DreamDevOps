import {
  CompanyCreated,
  CompanyProvisioned,
  CompanyProvisioningFailed,
  CompanyProvisioningRequested,
  CompanyRenamed,
} from '@dreamdevops/contracts/tenancy/events';
import { currentCompanyId, describeError, type DomainEvent, type EventContract, withRenewal } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { CompanyStatus } from '../domain/company.ts';
import { type GitProvider, PermanentProvisioningError } from './ports.ts';

/** The events that make a company's resources need checking. */
export const PROVISIONING_TRIGGERS: readonly EventContract[] = [CompanyCreated, CompanyRenamed, CompanyProvisioningRequested];

const GIT_ORGANIZATION = 'git-organization';
/** How long a job's claim on a company's resource lasts, unless the job renews it. */
const CLAIM_SECONDS = 120;
/** How often a working job renews its claim, well within the claim's length. */
const RENEW_MS = 30_000;

/** Another job is setting up the same resource. Thrown so this job is tried again later. */
export class ResourceBusyError extends Error {
  constructor() {
    super("Another job is setting up this company's resources. It will be tried again.");
    this.name = 'ResourceBusyError';
  }
}

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

  /**
   * Runs in the company's context. Throws to have the job retried later.
   *
   * Git is called with no transaction open. A short one first claims the resource, so two
   * jobs never set it up at once, and another records what happened, with the company as
   * it is then, since it may have been renamed or suspended meanwhile.
   */
  async reconcile(): Promise<void> {
    const company = await this.#database.transaction(async (tx) => {
      const found = await findCompany(tx);
      if (found === null || found.status === 'suspended') {
        return null;
      }
      if (!(await claim(tx))) {
        throw new ResourceBusyError();
      }
      return found;
    });
    if (company === null) {
      return;
    }

    let outcome: { externalId: string } | { error: unknown };
    try {
      const externalId = await withRenewal(() => this.#database.transaction((tx) => renewClaim(tx)), { everyMs: RENEW_MS }, () =>
        this.#git.ensureOrganization({ name: company.slug, displayName: company.name, companyId: currentCompanyId() }),
      );
      outcome = { externalId };
    } catch (error) {
      outcome = { error };
    }

    const failure = await this.#database.transaction(async (tx) => {
      const current = await findCompany(tx);
      if ('externalId' in outcome) {
        await recordStep(tx, { status: 'ready', externalId: outcome.externalId, error: null });
        // Renamed meanwhile: the rename's own job brings the organization's name along.
        if (current !== null && current.status !== 'suspended') {
          await setStatus(tx, current, 'active', () => CompanyProvisioned.create({ companyId: currentCompanyId(), payload: {} }));
        }
        return null;
      }
      const { error } = outcome;
      const attempts = await recordStep(tx, { status: 'failed', externalId: null, error: describeError(error) });
      if (error instanceof PermanentProvisioningError || attempts >= this.#options.maxAttempts) {
        if (current !== null && current.status !== 'suspended') {
          await setStatus(tx, current, 'provisioning-failed', () =>
            CompanyProvisioningFailed.create({ companyId: currentCompanyId(), payload: { reason: describeError(error) } }),
          );
        }
        return null;
      }
      return error;
    });

    // Thrown after the transaction commits, so the failed attempt stays recorded.
    if (failure !== null) {
      throw failure;
    }
  }
}

/** The company, locked while its status is read and changed. */
async function findCompany(tx: TenantTransaction): Promise<CompanyRow | null> {
  const { rows } = await tx.query<CompanyRow>('SELECT name, slug, status FROM tenancy.companies WHERE id = $1 FOR UPDATE', [
    currentCompanyId(),
  ]);
  return rows[0] ?? null;
}

/** Claims the company's Git organization for this job, unless another job's claim still holds. */
async function claim(tx: TenantTransaction): Promise<boolean> {
  await tx.query(
    `INSERT INTO tenancy.company_resources (company_id, kind, status) VALUES ($1, $2, 'pending')
     ON CONFLICT (company_id, kind) DO NOTHING`,
    [currentCompanyId(), GIT_ORGANIZATION],
  );
  const { rowCount } = await tx.query(
    `UPDATE tenancy.company_resources SET claimed_until = now() + make_interval(secs => $3)
     WHERE company_id = $1 AND kind = $2 AND (claimed_until IS NULL OR claimed_until < now())`,
    [currentCompanyId(), GIT_ORGANIZATION, CLAIM_SECONDS],
  );
  return rowCount === 1;
}

async function renewClaim(tx: TenantTransaction): Promise<void> {
  await tx.query(
    `UPDATE tenancy.company_resources SET claimed_until = now() + make_interval(secs => $3)
     WHERE company_id = $1 AND kind = $2`,
    [currentCompanyId(), GIT_ORGANIZATION, CLAIM_SECONDS],
  );
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
       claimed_until = NULL,
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
  event: () => DomainEvent,
): Promise<void> {
  if (company.status === status) {
    return;
  }
  await tx.query('UPDATE tenancy.companies SET status = $2, updated_at = now() WHERE id = $1', [
    currentCompanyId(),
    status,
  ]);
  await appendToOutbox(tx, [event()]);
}
