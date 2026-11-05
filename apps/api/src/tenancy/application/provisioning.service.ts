import { Logger } from '@nestjs/common';
import { createDomainEvent, currentCompanyId, type EventBus } from '@dreamdevops/shared-kernel';
import { appendToOutbox, type TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { ResourceKind, ResourceStatus } from '../domain/lifecycle.ts';
import { type GitHosting, ProvisioningError } from './ports.ts';
import type { RepositoryService } from './repositories.service.ts';

/** The events that ask for a company's resources to match what the company needs. */
export const PROVISIONING_TRIGGERS = [
  'CompanyCreated',
  'CompanyRenamed',
  'CompanyProvisioningRequested',
  'CompanyErased',
] as const;
const CONSUMER = 'tenancy-provisioning';

const UNREACHABLE = 'Git hosting could not be reached.';

interface ResourceRow {
  readonly kind: ResourceKind;
  readonly status: ResourceStatus;
  readonly external_name: string | null;
}

interface CompanyRow {
  readonly slug: string;
  readonly name: string;
  readonly status: string;
}

type Outcome =
  | { readonly status: 'ready'; readonly name: string; readonly url: string }
  | { readonly status: 'failed'; readonly error: string; readonly cause?: unknown };

/**
 * Creates what a company needs in other tools, keeps it up to date, and erases it once
 * the company is erased. It runs in the background, inside the company's context, so a
 * slow or failing tool never holds up a request. Each run checks everything again, so
 * running it twice does no harm.
 */
export class ProvisioningService {
  readonly #logger = new Logger(ProvisioningService.name);
  readonly #database: TenantDatabase;
  readonly #gitHosting: GitHosting;
  readonly #repositories: RepositoryService;

  constructor(database: TenantDatabase, gitHosting: GitHosting, repositories: RepositoryService) {
    this.#database = database;
    this.#gitHosting = gitHosting;
    this.#repositories = repositories;
  }

  /** Subscribes to the events that need provisioning. Failed runs are tried again later. */
  async subscribe(bus: EventBus): Promise<void> {
    for (const eventType of PROVISIONING_TRIGGERS) {
      await bus.subscribe(eventType, CONSUMER, () => this.provision(), { retryLimit: 5, retryDelaySeconds: 20 });
    }
  }

  /**
   * Brings the current company's resources up to date, then activates the company once
   * all of them are ready. It throws only when trying again later might help.
   */
  async provision(): Promise<void> {
    const loaded = await this.#database.transaction(async (tx) => {
      const { rows: companies } = await tx.query<CompanyRow>('SELECT slug, name, status FROM tenancy.companies');
      const { rows: resources } = await tx.query<ResourceRow>(
        'SELECT kind, status, external_name FROM tenancy.company_resources ORDER BY kind',
      );
      return { company: companies[0], resources };
    });
    const { company, resources } = loaded;
    if (company === undefined || company.status === 'closed') {
      return;
    }
    if (company.status === 'erased') {
      return this.#erase(resources);
    }

    let retryable: unknown;
    for (const { kind } of resources) {
      // No transaction stays open while another tool answers.
      const outcome = await this.#ensure(kind, company);
      await this.#database.transaction((tx) => record(tx, kind, outcome));
      if (outcome.status === 'failed' && outcome.cause !== undefined) {
        retryable ??= outcome.cause;
      }
    }

    await this.#database.transaction(activateIfReady);
    if (retryable !== undefined) {
      throw retryable;
    }
  }

  /** Erases what's left of an erased company in other tools. Names never reach events or logs. */
  async #erase(resources: readonly ResourceRow[]): Promise<void> {
    // The organization can only go once its applications' repositories have.
    const organization = resources.find((resource) => resource.kind === 'git-organization');
    const repositories = await this.#repositories.eraseAll(
      organization === undefined || organization.status === 'erased' ? null : organization.external_name,
    );
    if (!repositories.done) {
      if (repositories.retryable !== undefined) {
        throw repositories.retryable;
      }
      return;
    }

    let retryable: unknown;
    for (const resource of resources) {
      if (resource.status === 'erased') {
        continue;
      }
      let failure: { error: string; cause?: unknown } | null = null;
      try {
        if (resource.external_name !== null) {
          switch (resource.kind) {
            case 'git-organization':
              await this.#gitHosting.eraseOrganization({ name: resource.external_name, companyId: currentCompanyId() });
          }
        }
      } catch (error) {
        if (error instanceof ProvisioningError) {
          failure = { error: error.message };
        } else {
          this.#logger.warn(`Erasing ${resource.kind} for company ${currentCompanyId()} failed: ${String(error)}`);
          failure = { error: UNREACHABLE, cause: error };
          retryable ??= error;
        }
      }
      await this.#database.transaction((tx) => recordErasure(tx, resource.kind, failure));
    }
    if (retryable !== undefined) {
      throw retryable;
    }
  }

  async #ensure(kind: ResourceKind, company: CompanyRow): Promise<Outcome> {
    try {
      switch (kind) {
        case 'git-organization': {
          const organization = await this.#gitHosting.ensureOrganization({
            name: company.slug,
            displayName: company.name,
            companyId: currentCompanyId(),
          });
          return { status: 'ready', name: organization.name, url: organization.url };
        }
      }
    } catch (error) {
      if (error instanceof ProvisioningError) {
        return { status: 'failed', error: error.message };
      }
      this.#logger.warn(`Provisioning ${kind} for company ${currentCompanyId()} failed: ${String(error)}`);
      return { status: 'failed', error: UNREACHABLE, cause: error };
    }
  }
}

async function record(tx: TenantTransaction, kind: ResourceKind, outcome: Outcome): Promise<void> {
  const { rows } = await tx.query<{ status: ResourceStatus }>(
    'SELECT status FROM tenancy.company_resources WHERE kind = $1 FOR UPDATE',
    [kind],
  );
  const previous = rows[0]?.status;
  if (previous === undefined) {
    return;
  }

  if (outcome.status === 'ready') {
    await tx.query(
      `UPDATE tenancy.company_resources
       SET status = 'ready', external_name = $2, url = $3, last_error = NULL, attempts = attempts + 1,
           updated_at = now(), ready_at = coalesce(ready_at, now())
       WHERE kind = $1`,
      [kind, outcome.name, outcome.url],
    );
  } else {
    await tx.query(
      `UPDATE tenancy.company_resources
       SET status = 'failed', last_error = $2, attempts = attempts + 1, updated_at = now()
       WHERE kind = $1`,
      [kind, outcome.error],
    );
  }

  // Events mark changes, so repeating a run that changes nothing publishes nothing.
  if (previous === outcome.status) {
    return;
  }
  await appendToOutbox(tx, [
    outcome.status === 'ready'
      ? createDomainEvent({
          eventType: 'CompanyResourceProvisioned',
          companyId: currentCompanyId(),
          payload: { kind },
        })
      : createDomainEvent({
          eventType: 'CompanyResourceFailed',
          companyId: currentCompanyId(),
          payload: { kind, willRetry: outcome.cause !== undefined },
        }),
  ]);
}

async function recordErasure(
  tx: TenantTransaction,
  kind: ResourceKind,
  failure: { error: string; cause?: unknown } | null,
): Promise<void> {
  const { rows } = await tx.query<{ status: ResourceStatus }>(
    'SELECT status FROM tenancy.company_resources WHERE kind = $1 FOR UPDATE',
    [kind],
  );
  const previous = rows[0]?.status;
  if (previous === undefined || previous === 'erased') {
    return;
  }
  if (failure === null) {
    await tx.query(
      `UPDATE tenancy.company_resources
       SET status = 'erased', external_name = NULL, url = NULL, last_error = NULL, attempts = attempts + 1,
           updated_at = now()
       WHERE kind = $1`,
      [kind],
    );
    await appendToOutbox(tx, [
      createDomainEvent({ eventType: 'CompanyResourceErased', companyId: currentCompanyId(), payload: { kind } }),
    ]);
    return;
  }
  await tx.query(
    `UPDATE tenancy.company_resources
     SET status = 'failed', last_error = $2, attempts = attempts + 1, updated_at = now()
     WHERE kind = $1`,
    [kind, failure.error],
  );
  if (previous !== 'failed') {
    await appendToOutbox(tx, [
      createDomainEvent({
        eventType: 'CompanyResourceErasureFailed',
        companyId: currentCompanyId(),
        payload: { kind, willRetry: failure.cause !== undefined },
      }),
    ]);
  }
}

/** The row lock on the company means two runs finishing together activate it once. */
async function activateIfReady(tx: TenantTransaction): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE tenancy.companies SET status = 'active', status_changed_at = now()
     WHERE status = 'provisioning'
       AND NOT EXISTS (SELECT 1 FROM tenancy.company_resources WHERE status <> 'ready')`,
  );
  if (rowCount === 0) {
    return;
  }
  await appendToOutbox(tx, [
    createDomainEvent({ eventType: 'CompanyProvisioned', companyId: currentCompanyId(), payload: {} }),
  ]);
}
