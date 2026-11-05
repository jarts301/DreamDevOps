import { Logger } from '@nestjs/common';
import { createDomainEvent, currentCompanyId, type EventBus } from '@dreamdevops/shared-kernel';
import { appendToOutbox, type TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import {
  type ApplicationTypes,
  type GitHosting,
  ProvisioningError,
  type ScaffoldRenderer,
} from './ports.ts';

/** The events that ask for an application's repository. */
export const REPOSITORY_TRIGGERS = ['ApplicationCreated', 'ApplicationRepositoryRequested'] as const;
const CONSUMER = 'tenancy-repositories';

const UNREACHABLE = 'Git hosting could not be reached.';
const ORGANIZATION_NOT_READY = "The company's Git organization isn't ready yet.";

interface ApplicationRow {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly type: string | null;
  readonly scaffold: string | null;
}

interface Failure {
  readonly error: string;
  /** Set when trying again later might help. */
  readonly cause?: unknown;
}

/**
 * Makes each application's repository in its company's Git organization, starting from
 * its scaffold, and erases them with the company. It runs in the background, in the
 * company's context, and talks to Git hosting only through its API. It adds the scaffold
 * only while the repository has just its first commit, so it can run any number of times.
 */
export class RepositoryService {
  readonly #logger = new Logger(RepositoryService.name);
  readonly #database: TenantDatabase;
  readonly #gitHosting: GitHosting;
  readonly #scaffolds: ScaffoldRenderer;
  readonly #types: ApplicationTypes;

  constructor(database: TenantDatabase, gitHosting: GitHosting, scaffolds: ScaffoldRenderer, types: ApplicationTypes) {
    this.#database = database;
    this.#gitHosting = gitHosting;
    this.#scaffolds = scaffolds;
    this.#types = types;
  }

  async subscribe(bus: EventBus): Promise<void> {
    for (const eventType of REPOSITORY_TRIGGERS) {
      await bus.subscribe(
        eventType,
        CONSUMER,
        (event) => this.provision((event.payload as { applicationId: string }).applicationId),
        { retryLimit: 5, retryDelaySeconds: 20 },
      );
    }
  }

  /** Makes the application's repository, unless it's ready or its company no longer needs it. */
  async provision(applicationId: string): Promise<void> {
    const loaded = await this.#database.transaction(async (tx) => {
      const { rows: companies } = await tx.query<{ status: string; name: string }>(
        'SELECT status, name FROM tenancy.companies',
      );
      const { rows: organizations } = await tx.query<{ status: string; external_name: string | null }>(
        `SELECT status, external_name FROM tenancy.company_resources WHERE kind = 'git-organization'`,
      );
      const { rows: applications } = await tx.query<ApplicationRow>(
        'SELECT slug, name, description, type, scaffold FROM tenancy.applications WHERE id = $1',
        [applicationId],
      );
      const { rows: resources } = await tx.query<{ status: string }>(
        `SELECT status FROM tenancy.application_resources WHERE application_id = $1 AND kind = 'git-repository'`,
        [applicationId],
      );
      return { company: companies[0], organization: organizations[0], application: applications[0], resource: resources[0] };
    });
    const { company, organization, application, resource } = loaded;
    if (application === undefined || resource === undefined || resource.status === 'ready' || resource.status === 'erased') {
      return;
    }
    if (company === undefined || company.status === 'closed' || company.status === 'erased') {
      return;
    }
    if (organization?.status !== 'ready' || organization.external_name === null) {
      const waiting = new Error(ORGANIZATION_NOT_READY);
      await this.#database.transaction((tx) => recordFailure(tx, applicationId, { error: ORGANIZATION_NOT_READY, cause: waiting }));
      throw waiting;
    }

    let failure: Failure | null = null;
    let repository: { name: string; url: string } | null = null;
    try {
      // The organization may have gone from Git hosting since it was made, such as when
      // Forgejo's data was reset. This makes it again, so the repository has somewhere to go.
      await this.#gitHosting.ensureOrganization({
        name: organization.external_name,
        displayName: company.name,
        companyId: currentCompanyId(),
      });
      const found = await this.#gitHosting.ensureRepository({
        organization: organization.external_name,
        name: application.slug,
        description: application.description,
        // Keys, so Git hosting shows what kind of application each repository holds.
        topics: [application.type, application.scaffold].filter((topic): topic is string => topic !== null),
      });
      if (application.scaffold !== null) {
        await this.#gitHosting.addInitialFiles({
          organization: organization.external_name,
          repository: found.name,
          files: await this.#scaffolds.render(application.scaffold, application),
          message: `Start from the DreamDevOps ${this.#scaffoldName(application)} scaffold`,
        });
      }
      repository = found;
    } catch (error) {
      failure = this.#describe(error, applicationId);
    }

    await this.#database.transaction((tx) =>
      repository === null ? recordFailure(tx, applicationId, failure!) : recordReady(tx, applicationId, repository),
    );
    if (failure?.cause !== undefined) {
      throw failure.cause;
    }
  }

  /**
   * Deletes every repository of the current company's applications, for an erased company.
   * It answers whether all are gone, so the organization is erased only after them.
   */
  async eraseAll(organization: string | null): Promise<{ readonly done: boolean; readonly retryable?: unknown }> {
    const { rows: resources } = await this.#database.transaction((tx) =>
      tx.query<{ application_id: string; external_name: string | null }>(
        `SELECT application_id, external_name FROM tenancy.application_resources
         WHERE kind = 'git-repository' AND status <> 'erased'`,
      ),
    );
    let done = true;
    let retryable: unknown;
    for (const resource of resources) {
      let failure: Failure | null = null;
      try {
        if (organization !== null && resource.external_name !== null) {
          await this.#gitHosting.eraseRepository({ organization, name: resource.external_name });
        }
      } catch (error) {
        failure = this.#describe(error, resource.application_id);
        done = false;
        retryable ??= failure.cause;
      }
      await this.#database.transaction((tx) =>
        failure === null ? recordErased(tx, resource.application_id) : recordFailure(tx, resource.application_id, failure),
      );
    }
    return retryable === undefined ? { done } : { done, retryable };
  }

  #scaffoldName(application: ApplicationRow): string {
    const scaffolds = application.type === null ? [] : this.#types.scaffoldsOf(application.type);
    return scaffolds.find((scaffold) => scaffold.key === application.scaffold)?.name ?? application.scaffold ?? '';
  }

  #describe(error: unknown, applicationId: string): Failure {
    if (error instanceof ProvisioningError) {
      return { error: error.message };
    }
    this.#logger.warn(`The repository of application ${applicationId} failed: ${String(error)}`);
    return { error: UNREACHABLE, cause: error };
  }
}

async function lockStatus(tx: TenantTransaction, applicationId: string): Promise<string | undefined> {
  const { rows } = await tx.query<{ status: string }>(
    `SELECT status FROM tenancy.application_resources WHERE application_id = $1 AND kind = 'git-repository' FOR UPDATE`,
    [applicationId],
  );
  return rows[0]?.status;
}

async function recordReady(tx: TenantTransaction, applicationId: string, repository: { name: string; url: string }): Promise<void> {
  const previous = await lockStatus(tx, applicationId);
  if (previous === undefined || previous === 'ready') {
    return;
  }
  await tx.query(
    `UPDATE tenancy.application_resources
     SET status = 'ready', external_name = $2, url = $3, last_error = NULL, attempts = attempts + 1,
         updated_at = now(), ready_at = coalesce(ready_at, now())
     WHERE application_id = $1 AND kind = 'git-repository'`,
    [applicationId, repository.name, repository.url],
  );
  await appendToOutbox(tx, [
    createDomainEvent({ eventType: 'ApplicationRepositoryCreated', companyId: currentCompanyId(), payload: { applicationId } }),
  ]);
}

async function recordFailure(tx: TenantTransaction, applicationId: string, failure: Failure): Promise<void> {
  const previous = await lockStatus(tx, applicationId);
  if (previous === undefined || previous === 'ready' || previous === 'erased') {
    return;
  }
  await tx.query(
    `UPDATE tenancy.application_resources
     SET status = 'failed', last_error = $2, attempts = attempts + 1, updated_at = now()
     WHERE application_id = $1 AND kind = 'git-repository'`,
    [applicationId, failure.error],
  );
  if (previous !== 'failed') {
    await appendToOutbox(tx, [
      createDomainEvent({
        eventType: 'ApplicationRepositoryFailed',
        companyId: currentCompanyId(),
        payload: { applicationId, willRetry: failure.cause !== undefined },
      }),
    ]);
  }
}

async function recordErased(tx: TenantTransaction, applicationId: string): Promise<void> {
  const previous = await lockStatus(tx, applicationId);
  if (previous === undefined || previous === 'erased') {
    return;
  }
  await tx.query(
    `UPDATE tenancy.application_resources
     SET status = 'erased', external_name = NULL, url = NULL, last_error = NULL, attempts = attempts + 1,
         updated_at = now()
     WHERE application_id = $1 AND kind = 'git-repository'`,
    [applicationId],
  );
  await appendToOutbox(tx, [
    createDomainEvent({ eventType: 'ApplicationRepositoryErased', companyId: currentCompanyId(), payload: { applicationId } }),
  ]);
}
