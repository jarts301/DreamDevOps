import { createDomainEvent, currentCompanyId, describeError } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { BlueprintCatalog } from '../../blueprints/application/blueprint-catalog.ts';
import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import type { Principal } from '../../identity-access/domain/access.ts';
import type { CompanyDirectory, CompanyRecord } from '../../tenancy/application/company-directory.ts';
import { SourceError } from '../domain/errors.ts';
import type { RepositoryCreatedPayload, RepositoryRequestedPayload } from '../domain/events.ts';
import { GIT_FLOW } from '../domain/git-flow.ts';
import { PermanentSourceError, type RepositorySpec, type SourceHost } from './ports.ts';
import type { RepositoryLocation, RepositoryLookup } from './repository-lookup.ts';

/** The events that make an application's repository need creating. */
export const REPOSITORY_TRIGGERS = ['ApplicationRegistered', 'RepositoryRequested'] as const;

export type RepositoryStatus = 'creating' | 'ready' | 'failed';

export interface RepositoryView {
  readonly applicationId: string;
  readonly status: RepositoryStatus;
  readonly fullName: string;
  readonly url: string;
  readonly blueprint: { readonly key: string; readonly version: string } | null;
  readonly lastError: string | null;
}

interface RepositoryRow {
  application_id: string;
  organization: string;
  name: string;
  status: RepositoryStatus;
  blueprint_key: string | null;
  blueprint_version: string | null;
  attempts: number;
  last_error: string | null;
}

export interface RepositoriesOptions {
  /** Attempts before the repository is marked as failed, so someone can step in. */
  readonly maxAttempts: number;
  /** Forgejo's address in the browser, for links. */
  readonly publicUrl: string;
}

/**
 * Creates each application's repository from its blueprint, with Git Flow branches and
 * rules. Every step is safe to repeat, so a retry carries on where the last one stopped.
 */
export class Repositories implements RepositoryLookup {
  readonly #database: TenantDatabase;
  readonly #companies: CompanyDirectory;
  readonly #host: SourceHost;
  readonly #catalog: ApplicationCatalog;
  readonly #blueprints: BlueprintCatalog;
  readonly #options: RepositoriesOptions;

  constructor(
    database: TenantDatabase,
    companies: CompanyDirectory,
    host: SourceHost,
    catalog: ApplicationCatalog,
    blueprints: BlueprintCatalog,
    options: RepositoriesOptions,
  ) {
    this.#database = database;
    this.#companies = companies;
    this.#host = host;
    this.#catalog = catalog;
    this.#blueprints = blueprints;
    this.#options = options;
  }

  /** The current company's repositories. */
  list(): Promise<RepositoryView[]> {
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<RepositoryRow>('SELECT * FROM source.repositories ORDER BY name');
      return rows.map((row) => this.#toView(row));
    });
  }

  async find(applicationId: string): Promise<RepositoryLocation | null> {
    return this.#locate('application_id = $1', [applicationId]);
  }

  async findByName(organization: string, name: string): Promise<RepositoryLocation | null> {
    return this.#locate('organization = $1 AND name = $2', [organization, name]);
  }

  /**
   * Asks for a repository to be created, or tried again after it failed. Applications
   * registered before repositories existed need this once.
   */
  async request(actor: Principal, applicationId: unknown): Promise<void> {
    const application = await this.#catalog.get(applicationId);
    if (application.status === 'archived') {
      throw new SourceError('conflict', 'Restore the application first.');
    }
    await this.#database.transaction(async (tx) => {
      const row = await lockRow(tx, application.id);
      if (row?.status === 'ready') {
        throw new SourceError('conflict', 'This application already has a repository.');
      }
      if (row?.status === 'creating') {
        return;
      }
      await upsertCreating(tx, application.id, (await this.#currentCompany()).slug, application.slug);
      await appendToOutbox(tx, [
        createDomainEvent<'RepositoryRequested', RepositoryRequestedPayload>({
          eventType: 'RepositoryRequested',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { applicationId: application.id },
        }),
      ]);
    });
  }

  /** Runs in the application's company. Throws to have the job tried again later. */
  async provision(applicationId: string): Promise<void> {
    const application = await this.#catalog.get(applicationId);
    const failure = await this.#database.transaction(async (tx) => {
      const company = await this.#currentCompany();
      let row = await lockRow(tx, applicationId);
      if (row?.status === 'ready') {
        return null;
      }
      if (row === null) {
        await upsertCreating(tx, applicationId, company.slug, application.slug);
        row = (await lockRow(tx, applicationId))!;
      }
      const spec: RepositorySpec = { organization: row.organization, name: row.name, applicationId };

      try {
        if (company.status !== 'active') {
          throw new Error("The company's Git organization isn't ready yet.");
        }
        let blueprintKey = row.blueprint_key;
        let blueprintVersion = row.blueprint_version;
        if (blueprintKey === null || blueprintVersion === null) {
          const blueprint = this.#blueprints.latestForType(application.type.key);
          if (blueprint === null) {
            throw new PermanentSourceError(`No blueprint exists for the ${application.type.name} type.`);
          }
          blueprintKey = blueprint.key;
          blueprintVersion = blueprint.version;
          await tx.query(
            'UPDATE source.repositories SET blueprint_key = $2, blueprint_version = $3 WHERE application_id = $1',
            [applicationId, blueprintKey, blueprintVersion],
          );
        }

        await this.#host.ensureTeams(spec.organization);
        const repository = await this.#host.ensureRepository(spec);
        if (repository.empty) {
          const files = this.#blueprints.render(blueprintKey, blueprintVersion, {
            name: application.name,
            slug: application.slug,
          });
          await this.#host.commitInitialFiles(spec, files, `Start from the ${blueprintKey} ${blueprintVersion} blueprint`);
        }
        await this.#host.applyGitFlow(spec, GIT_FLOW);
        if (application.status === 'archived') {
          await this.#host.setArchived(spec, true);
        }

        await tx.query(
          `UPDATE source.repositories
           SET status = 'ready', external_id = $2, attempts = 0, last_error = NULL, updated_at = now()
           WHERE application_id = $1`,
          [applicationId, repository.id],
        );
        await appendToOutbox(tx, [
          createDomainEvent<'RepositoryCreated', RepositoryCreatedPayload>({
            eventType: 'RepositoryCreated',
            companyId: currentCompanyId(),
            payload: {
              applicationId,
              name: application.name,
              repository: `${spec.organization}/${spec.name}`,
              blueprint: blueprintKey,
              blueprintVersion,
            },
          }),
        ]);
        return null;
      } catch (error) {
        const reason = describeError(error);
        const attempts = row.attempts + 1;
        const failed = error instanceof PermanentSourceError || attempts >= this.#options.maxAttempts;
        await tx.query(
          `UPDATE source.repositories SET status = $2, attempts = $3, last_error = $4, updated_at = now()
           WHERE application_id = $1`,
          [applicationId, failed ? 'failed' : 'creating', attempts, reason],
        );
        if (failed) {
          await appendToOutbox(tx, [
            createDomainEvent({
              eventType: 'RepositoryCreationFailed',
              companyId: currentCompanyId(),
              payload: { applicationId, name: application.name, reason },
            }),
          ]);
          return null;
        }
        return error;
      }
    });

    // Thrown after the transaction commits, so the failed attempt stays recorded.
    if (failure !== null) {
      throw failure;
    }
  }

  /** Makes the repository read-only while its application is archived. */
  async syncArchived(applicationId: string, archived: boolean): Promise<void> {
    const row = await this.#database.transaction((tx) => lockRow(tx, applicationId));
    if (row?.status !== 'ready') {
      return;
    }
    await this.#host.setArchived({ organization: row.organization, name: row.name, applicationId }, archived);
  }

  async #locate(where: string, values: readonly string[]): Promise<RepositoryLocation | null> {
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<RepositoryRow>(`SELECT * FROM source.repositories WHERE ${where}`, [...values]);
      const row = rows[0];
      return row === undefined
        ? null
        : { applicationId: row.application_id, organization: row.organization, name: row.name, status: row.status };
    });
  }

  /** The company the work runs for. Its context is only ever set for a company that exists. */
  async #currentCompany(): Promise<CompanyRecord> {
    return (await this.#companies.find(currentCompanyId()))!;
  }

  #toView(row: RepositoryRow): RepositoryView {
    const fullName = `${row.organization}/${row.name}`;
    return {
      applicationId: row.application_id,
      status: row.status,
      fullName,
      url: `${this.#options.publicUrl.replace(/\/$/, '')}/${fullName}`,
      blueprint:
        row.blueprint_key === null || row.blueprint_version === null
          ? null
          : { key: row.blueprint_key, version: row.blueprint_version },
      lastError: row.last_error,
    };
  }
}

async function lockRow(tx: TenantTransaction, applicationId: string): Promise<RepositoryRow | null> {
  const { rows } = await tx.query<RepositoryRow>(
    'SELECT * FROM source.repositories WHERE application_id = $1 FOR UPDATE',
    [applicationId],
  );
  return rows[0] ?? null;
}

async function upsertCreating(tx: TenantTransaction, applicationId: string, organization: string, name: string) {
  await tx.query(
    `INSERT INTO source.repositories (application_id, company_id, organization, name, status)
     VALUES ($1, $2, $3, $4, 'creating')
     ON CONFLICT (application_id) DO UPDATE SET status = 'creating', attempts = 0, last_error = NULL, updated_at = now()`,
    [applicationId, currentCompanyId(), organization, name],
  );
}

