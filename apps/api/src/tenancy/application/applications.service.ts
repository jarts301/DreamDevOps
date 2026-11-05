import { createDomainEvent, currentCompanyId } from '@dreamdevops/shared-kernel';
import { appendToOutbox, type TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import { TenancyError } from '../domain/errors.ts';
import { type ApplicationAction, type ApplicationStatus, nextApplicationStatus } from '../domain/lifecycle.ts';
import { parseDescription, parseName, parseSlug, slugOrFromName } from '../domain/names.ts';
import type { Actor } from './company-registry.service.ts';
import type { ApplicationTypes } from './ports.ts';
import { fieldsOf, isUniqueViolation, uuid } from './values.ts';

export interface Application {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** The Application Catalog type it was registered as, or null if it predates types. */
  readonly type: string | null;
  /** The scaffold its repository started from, or null if it started empty. */
  readonly scaffold: string | null;
  /** Its Git repository in the company's organization, or null if it predates repositories. */
  readonly repository: ApplicationRepository | null;
  readonly status: ApplicationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface ApplicationRepository {
  readonly status: 'pending' | 'ready' | 'failed' | 'erased';
  readonly name: string | null;
  readonly url: string | null;
  readonly lastError: string | null;
}

type ApplicationRow = Omit<Application, 'repository'>;

const COLUMNS = `id, slug, name, description, type, scaffold, status, created_at AS "createdAt",
  updated_at AS "updatedAt", archived_at AS "archivedAt"`;

const EVENT_OF_ACTION: Readonly<Record<ApplicationAction, string>> = {
  archive: 'ApplicationArchived',
  restore: 'ApplicationRestored',
};

const notFound = () => new TenancyError('not-found', 'This application does not exist.');

/**
 * The current company's applications. Archiving keeps an application and its slug, so
 * its history stays readable. Row-level security limits every query to the company.
 */
export class ApplicationsService {
  readonly #database: TenantDatabase;
  readonly #types: ApplicationTypes;

  constructor(database: TenantDatabase, types: ApplicationTypes) {
    this.#database = database;
    this.#types = types;
  }

  list(): Promise<Application[]> {
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<ApplicationRow>(
        `SELECT ${COLUMNS} FROM tenancy.applications ORDER BY status, lower(name), slug`,
      );
      return withRepositories(tx, rows);
    });
  }

  get(idValue: unknown): Promise<Application> {
    const id = uuid(idValue);
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<ApplicationRow>(`SELECT ${COLUMNS} FROM tenancy.applications WHERE id = $1`, [
        id,
      ]);
      if (rows.length === 0) {
        throw notFound();
      }
      return (await withRepositories(tx, rows))[0]!;
    });
  }

  async create(actor: Actor, body: unknown): Promise<Application> {
    const fields = fieldsOf(body);
    const name = parseName(fields['name'], 'application');
    const slug = slugOrFromName(fields['slug'], name, parseSlug);
    const description = parseDescription(fields['description']);
    const type = fields['type'];
    if (typeof type !== 'string' || !this.#types.has(type)) {
      throw new TenancyError('invalid', 'Choose one of the application types in the catalog.');
    }
    const scaffold = this.#scaffoldFor(type, fields['scaffold']);
    try {
      return await this.#database.transaction(async (tx) => {
        const { rows } = await tx.query<ApplicationRow>(
          `INSERT INTO tenancy.applications (company_id, slug, name, description, type, scaffold, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING ${COLUMNS}`,
          [currentCompanyId(), slug, name, description, type, scaffold, actor.userId],
        );
        const application = rows[0]!;
        // Its repository is made in the background, once this commits.
        await tx.query(
          `INSERT INTO tenancy.application_resources (application_id, company_id, kind) VALUES ($1, $2, 'git-repository')`,
          [application.id, currentCompanyId()],
        );
        await appendToOutbox(tx, [
          createDomainEvent({
            eventType: 'ApplicationCreated',
            companyId: currentCompanyId(),
            payload: { applicationId: application.id, type, scaffold, createdBy: actor.userId },
          }),
        ]);
        return (await withRepositories(tx, [application]))[0]!;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'applications_company_id_slug_key')) {
        throw new TenancyError('conflict', `Another application in this company already uses the slug "${slug}".`);
      }
      throw error;
    }
  }

  /** Changes the name or description. The slug can't change, because other tools use it. */
  update(actor: Actor, idValue: unknown, body: unknown): Promise<Application> {
    const id = uuid(idValue);
    const fields = fieldsOf(body);
    const wanted: { name?: string; description?: string } = {};
    if (fields['name'] !== undefined) {
      wanted.name = parseName(fields['name'], 'application');
    }
    if (fields['description'] !== undefined) {
      wanted.description = parseDescription(fields['description']);
    }
    if (fields['slug'] !== undefined) {
      throw new TenancyError('invalid', "An application's slug can't change.");
    }
    if (fields['scaffold'] !== undefined) {
      throw new TenancyError('invalid', "An application's scaffold can't change, because its repository started from it.");
    }
    if (fields['type'] !== undefined) {
      throw new TenancyError('invalid', "An application's type can't change, because it decides how it's built and run.");
    }
    if (wanted.name === undefined && wanted.description === undefined) {
      throw new TenancyError('invalid', 'Send a new name or description.');
    }

    return this.#database.transaction(async (tx) => {
      const current = await lockApplication(tx, id);
      if (current.status === 'archived') {
        throw new TenancyError('conflict', 'Restore this application before changing it.');
      }
      const changed = (['name', 'description'] as const).filter(
        (field) => wanted[field] !== undefined && wanted[field] !== current[field],
      );
      if (changed.length === 0) {
        return (await withRepositories(tx, [current]))[0]!;
      }
      const { rows } = await tx.query<ApplicationRow>(
        `UPDATE tenancy.applications
         SET name = coalesce($2, name), description = coalesce($3, description), updated_at = now()
         WHERE id = $1
         RETURNING ${COLUMNS}`,
        [id, wanted.name ?? null, wanted.description ?? null],
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'ApplicationUpdated',
          companyId: currentCompanyId(),
          payload: { applicationId: id, changed, updatedBy: actor.userId },
        }),
      ]);
      return (await withRepositories(tx, rows))[0]!;
    });
  }

  changeStatus(actor: Actor, idValue: unknown, action: ApplicationAction): Promise<Application> {
    const id = uuid(idValue);
    return this.#database.transaction(async (tx) => {
      const current = await lockApplication(tx, id);
      const status = nextApplicationStatus(current.status, action);
      const { rows } = await tx.query<ApplicationRow>(
        `UPDATE tenancy.applications
         SET status = $2, updated_at = now(), archived_at = CASE WHEN $2 = 'archived' THEN now() END
         WHERE id = $1
         RETURNING ${COLUMNS}`,
        [id, status],
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: EVENT_OF_ACTION[action],
          companyId: currentCompanyId(),
          payload: { applicationId: id, changedBy: actor.userId },
        }),
      ]);
      return (await withRepositories(tx, rows))[0]!;
    });
  }

  /** Makes the repository again after a failure, or for an application that predates repositories. */
  requestRepository(actor: Actor, idValue: unknown): Promise<Application> {
    const id = uuid(idValue);
    return this.#database.transaction(async (tx) => {
      const application = await lockApplication(tx, id);
      const { rows } = await tx.query<{ status: string }>(
        `INSERT INTO tenancy.application_resources (application_id, company_id, kind)
         VALUES ($1, $2, 'git-repository')
         ON CONFLICT (application_id, kind) DO UPDATE SET status = tenancy.application_resources.status
         RETURNING status`,
        [id, currentCompanyId()],
      );
      if (rows[0]!.status === 'ready') {
        throw new TenancyError('conflict', "This application's repository is already ready.");
      }
      await tx.query(
        `UPDATE tenancy.application_resources SET status = 'pending', last_error = NULL, updated_at = now()
         WHERE application_id = $1 AND kind = 'git-repository'`,
        [id],
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'ApplicationRepositoryRequested',
          companyId: currentCompanyId(),
          payload: { applicationId: id, requestedBy: actor.userId },
        }),
      ]);
      return (await withRepositories(tx, [application]))[0]!;
    });
  }

  /** A type with scaffolds needs one chosen, or null for an empty repository. */
  #scaffoldFor(type: string, value: unknown): string | null {
    const scaffolds = this.#types.scaffoldsOf(type);
    if (value === null || (value === undefined && scaffolds.length === 0)) {
      return null;
    }
    if (typeof value !== 'string' || !scaffolds.some((scaffold) => scaffold.key === value)) {
      throw new TenancyError(
        'invalid',
        scaffolds.length === 0
          ? 'This application type has no scaffolds, so its repository starts empty.'
          : `Choose a scaffold for this type: ${scaffolds.map((scaffold) => scaffold.key).join(', ')}, or none for an empty repository.`,
      );
    }
    return value;
  }
}

/** Adds each application's repository, read from the resources the company may see. */
async function withRepositories(tx: TenantTransaction, rows: readonly ApplicationRow[]): Promise<Application[]> {
  const { rows: repositories } = await tx.query<ApplicationRepository & { applicationId: string }>(
    `SELECT application_id AS "applicationId", status, external_name AS name, url, last_error AS "lastError"
     FROM tenancy.application_resources
     WHERE kind = 'git-repository' AND application_id = ANY($1::uuid[])`,
    [rows.map((row) => row.id)],
  );
  const byApplication = new Map(repositories.map(({ applicationId, ...repository }) => [applicationId, repository]));
  return rows.map((row) => ({ ...serialize(row), repository: byApplication.get(row.id) ?? null }));
}

async function lockApplication(tx: TenantTransaction, id: string): Promise<ApplicationRow> {
  const { rows } = await tx.query<ApplicationRow>(
    `SELECT ${COLUMNS} FROM tenancy.applications WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const application = rows[0];
  if (application === undefined) {
    throw notFound();
  }
  return application;
}

/** The driver returns dates as Date objects, and the API answers with ISO strings. */
function serialize(row: ApplicationRow): ApplicationRow {
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string));
  return {
    ...row,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: row.archivedAt === null ? null : iso(row.archivedAt),
  };
}
