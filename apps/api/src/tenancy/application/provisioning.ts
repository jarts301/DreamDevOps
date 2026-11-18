import {
  CompanyCreated,
  CompanyProvisioned,
  CompanyProvisioningFailed,
  CompanyProvisioningRequested,
  CompanyRenamed,
} from '@dreamdevops/contracts/tenancy/events';
import { currentCompanyId, describeError, type DomainEvent, type EventContract, withRenewal } from '@dreamdevops/shared-kernel';
import type { CompanyStatus } from '../domain/company.ts';
import { type GitProvider, PermanentProvisioningError, type StoredCompany, type TenancySession, type TenancyStore } from './ports.ts';

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

/**
 * The provisioning saga. It brings a company's resources in line with the company,
 * one step at a time, and records each step, so a retry resumes where it stopped.
 * Every step is safe to repeat, because events can arrive more than once.
 */
export class ProvisioningSaga {
  readonly #store: TenancyStore;
  readonly #git: GitProvider;
  readonly #options: ProvisioningOptions;

  constructor(store: TenancyStore, git: GitProvider, options: ProvisioningOptions) {
    this.#store = store;
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
    const company = await this.#store.transaction(async (session) => {
      const found = await session.lockCompany(currentCompanyId());
      if (found === null || found.status === 'suspended') {
        return null;
      }
      if (!(await session.claimResource(currentCompanyId(), GIT_ORGANIZATION, CLAIM_SECONDS))) {
        throw new ResourceBusyError();
      }
      return found;
    });
    if (company === null) {
      return;
    }

    let outcome: { externalId: string } | { error: unknown };
    try {
      const renew = () => this.#store.transaction((session) => session.renewClaim(currentCompanyId(), GIT_ORGANIZATION, CLAIM_SECONDS));
      const externalId = await withRenewal(renew, { everyMs: RENEW_MS }, () =>
        this.#git.ensureOrganization({ name: company.slug, displayName: company.name, companyId: currentCompanyId() }),
      );
      outcome = { externalId };
    } catch (error) {
      outcome = { error };
    }

    const failure = await this.#store.transaction(async (session) => {
      const current = await session.lockCompany(currentCompanyId());
      if ('externalId' in outcome) {
        await session.recordStep(currentCompanyId(), GIT_ORGANIZATION, { status: 'ready', externalId: outcome.externalId, error: null });
        // Renamed meanwhile: the rename's own job brings the organization's name along.
        if (current !== null && current.status !== 'suspended') {
          await setStatus(session, current, 'active', () => CompanyProvisioned.create({ companyId: currentCompanyId(), payload: {} }));
        }
        return null;
      }
      const { error } = outcome;
      const attempts = await session.recordStep(currentCompanyId(), GIT_ORGANIZATION, {
        status: 'failed',
        externalId: null,
        error: describeError(error),
      });
      if (error instanceof PermanentProvisioningError || attempts >= this.#options.maxAttempts) {
        if (current !== null && current.status !== 'suspended') {
          await setStatus(session, current, 'provisioning-failed', () =>
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

/** Moves the company to a status, with its event, unless it's there already. */
async function setStatus(
  session: TenancySession,
  company: StoredCompany,
  status: CompanyStatus,
  event: () => DomainEvent,
): Promise<void> {
  if (company.status === status) {
    return;
  }
  await session.setStatus(currentCompanyId(), status);
  await session.record([event()]);
}
