import { createDomainEvent, currentCompanyId } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { BlueprintLibrary } from '../../blueprints/infrastructure/blueprint-library.ts';
import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import { CatalogError } from '../../catalog/domain/errors.ts';
import type { Principal } from '../../identity-access/domain/access.ts';
import { GIT_FLOW } from '../domain/git-flow.ts';
import { PermanentSourceError, type RepositorySpec, type SourceHost } from './ports.ts';

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
export class Repositories {
  readonly #database: TenantDatabase;
  readonly #host: SourceHost;
  readonly #catalog: ApplicationCatalog;
  readonly #blueprints: BlueprintLibrary;
  readonly #options: RepositoriesOptions;

  constructor(
    database: TenantDatabase,
    host: SourceHost,
    catalog: ApplicationCatalog,
    blueprints: BlueprintLibrary,
    options: RepositoriesOptions,
  ) {
    this.#database = database;
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

  /**
   * Asks for a repository to be created, or tried again after it failed. Applications
   * registered before repositories existed need this once.
   */
  async request(actor: Principal, applicationId: unknown): Promise<void> {
    const application = await this.#catalog.get(applicationId);
    if (application.status === 'archived') {
      throw new CatalogError('conflict', 'Restore the application first.');
    }
    await this.#database.transaction(async (tx) => {
      const row = await lockRow(tx, application.id);
      if (row?.status === 'ready') {
        throw new CatalogError('conflict', 'This application already has a repository.');
      }
      if (row?.status === 'creating') {
        return;
      }
      await upsertCreating(tx, application.id, await organizationOf(tx), application.slug);
      await appendToOutbox(tx, [
        createDomainEvent({
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
      const company = await companyOf(tx);
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
          createDomainEvent({
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
        const reason = describe(error);
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

async function companyOf(tx: TenantTransaction): Promise<{ slug: string; status: string }> {
  const { rows } = await tx.query<{ slug: string; status: string }>(
    'SELECT slug, status FROM tenancy.companies WHERE id = $1',
    [currentCompanyId()],
  );
  return rows[0]!;
}

async function organizationOf(tx: TenantTransaction): Promise<string> {
  return (await companyOf(tx)).slug;
}

/** Error text from other tools is kept short, because people see it. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return message.slice(0, 300);
}
