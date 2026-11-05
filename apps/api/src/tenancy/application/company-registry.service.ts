import { randomUUID } from 'node:crypto';
import { type CompanyId, createDomainEvent, currentCompanyId, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { appendToOutbox, type TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { Pool } from 'pg';
import { TenancyError } from '../domain/errors.ts';
import {
  type CompanyAction,
  type CompanyStatus,
  nextCompanyStatus,
  REQUIRED_RESOURCES,
} from '../domain/lifecycle.ts';
import { parseCompanySlug, parseName, slugOrFromName } from '../domain/names.ts';
import { isUniqueViolation, uuid } from './values.ts';

export interface Actor {
  readonly userId: string;
}

export interface CompanyResource {
  readonly kind: string;
  readonly status: string;
  readonly name: string | null;
  readonly url: string | null;
}

/** A company as a Platform Admin sees it: no company data, only its registry entry. */
export interface PlatformCompany {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: CompanyStatus;
  readonly createdAt: string;
  readonly statusChangedAt: string;
  readonly erasedAt: string | null;
  readonly memberCount: number;
  readonly resources: readonly (CompanyResource & {
    readonly lastError: string | null;
    readonly attempts: number;
    readonly updatedAt: string;
  })[];
}

/** The current company, as its members see it. */
export interface CompanyProfile {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: CompanyStatus;
  readonly resources: readonly CompanyResource[];
}

interface PlatformCompanyRow {
  id: string;
  slug: string;
  name: string;
  status: CompanyStatus;
  created_at: Date;
  status_changed_at: Date;
  erased_at: Date | null;
  member_count: number;
  resources: PlatformCompany['resources'];
}

const EVENT_OF_ACTION: Readonly<Record<CompanyAction, string>> = {
  suspend: 'CompanySuspended',
  reactivate: 'CompanyReactivated',
  close: 'CompanyClosed',
  erase: 'CompanyErased',
};

/**
 * The registry of companies and their lifecycle. Every change publishes an event, and
 * creating a company or asking again starts provisioning its resources in the background.
 *
 * Event payloads hold IDs, never names or slugs, so erasing a company never has to
 * rewrite the events, or the job copies made of them, that were already published.
 *
 * Platform Admins act on one company by its ID. Those calls enter that company's
 * context only to change its registry entry, never to read its data.
 */
export class CompanyRegistryService {
  readonly #database: TenantDatabase;
  readonly #pool: Pool;

  constructor(database: TenantDatabase, pool: Pool) {
    this.#database = database;
    this.#pool = pool;
  }

  async list(): Promise<PlatformCompany[]> {
    const { rows } = await this.#pool.query<PlatformCompanyRow>('SELECT * FROM tenancy.platform_companies()');
    return rows.map(toPlatformCompany);
  }

  async get(idValue: unknown): Promise<PlatformCompany> {
    const { rows } = await this.#pool.query<PlatformCompanyRow>('SELECT * FROM tenancy.platform_companies($1)', [
      uuid(idValue),
    ]);
    const company = rows[0];
    if (company === undefined) {
      throw notFound();
    }
    return toPlatformCompany(company);
  }

  async create(actor: Actor, nameValue: unknown, slugValue: unknown): Promise<PlatformCompany> {
    const name = parseName(nameValue, 'company');
    const slug = slugOrFromName(slugValue, name, parseCompanySlug);
    // The server makes the ID, so no client chooses which company context this runs in.
    const id = parseCompanyId(randomUUID());
    try {
      await runWithCompany(id, () =>
        this.#database.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO tenancy.companies (id, slug, name, status, created_by) VALUES ($1, $2, $3, 'provisioning', $4)`,
            [id, slug, name, actor.userId],
          );
          await tx.query(
            'INSERT INTO tenancy.company_resources (company_id, kind) SELECT $1, unnest($2::text[])',
            [id, [...REQUIRED_RESOURCES]],
          );
          await appendToOutbox(tx, [
            createDomainEvent({
              eventType: 'CompanyCreated',
              companyId: id,
              payload: { createdBy: actor.userId },
            }),
          ]);
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error, 'companies_slug_key')) {
        throw new TenancyError('conflict', `Another company already uses the slug "${slug}".`);
      }
      throw error;
    }
    return this.get(id);
  }

  /** The slug names the company's resources elsewhere, so only the name can change. */
  async rename(actor: Actor, idValue: unknown, nameValue: unknown): Promise<PlatformCompany> {
    const id = companyId(idValue);
    const name = parseName(nameValue, 'company');
    await this.#inCompany(id, async (tx) => {
      const company = await lockCompany(tx);
      if (company.status === 'closed' || company.status === 'erased') {
        throw new TenancyError('conflict', `A ${company.status} company can't be renamed.`);
      }
      if (company.name === name) {
        return;
      }
      await tx.query('UPDATE tenancy.companies SET name = $1', [name]);
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'CompanyRenamed',
          companyId: currentCompanyId(),
          payload: { renamedBy: actor.userId },
        }),
      ]);
    });
    return this.get(id);
  }

  async changeStatus(
    actor: Actor,
    idValue: unknown,
    action: Exclude<CompanyAction, 'erase'>,
  ): Promise<PlatformCompany> {
    const id = companyId(idValue);
    await this.#inCompany(id, async (tx) => {
      const company = await lockCompany(tx);
      const status = nextCompanyStatus(company.status, action);
      await tx.query('UPDATE tenancy.companies SET status = $1, status_changed_at = now()', [status]);
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: EVENT_OF_ACTION[action],
          companyId: currentCompanyId(),
          payload: { previousStatus: company.status, changedBy: actor.userId },
        }),
      ]);
    });
    return this.get(id);
  }

  /**
   * Erases a closed company's data for good, to meet data protection laws. Its rows stay,
   * so history and references stay whole, but everything in them that identifies the
   * company, its applications or the people it invited is replaced. Its resources in
   * other tools are then erased in the background.
   *
   * The caller confirms with the company's slug, so no mistyped ID can erase a company.
   */
  async erase(actor: Actor, idValue: unknown, confirmation: unknown): Promise<PlatformCompany> {
    const id = companyId(idValue);
    await this.#inCompany(id, async (tx) => {
      const company = await lockCompany(tx);
      nextCompanyStatus(company.status, 'erase');
      if (confirmation !== company.slug) {
        throw new TenancyError('invalid', 'To erase this company, confirm with its slug.');
      }
      await tx.query('SELECT tenancy.erase_current_company($1)', [actor.userId]);
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: EVENT_OF_ACTION.erase,
          companyId: currentCompanyId(),
          payload: { erasedBy: actor.userId },
        }),
      ]);
    });
    return this.get(id);
  }

  /**
   * Tries failed resources again, and checks that ready ones are still as they should be.
   * For an erased company, it tries again to erase them.
   */
  async requestProvisioning(actor: Actor, idValue: unknown): Promise<PlatformCompany> {
    const id = companyId(idValue);
    await this.#inCompany(id, async (tx) => {
      const company = await lockCompany(tx);
      if (company.status === 'closed') {
        throw new TenancyError('conflict', "A closed company's resources can't be provisioned.");
      }
      await tx.query(
        `UPDATE tenancy.company_resources SET status = 'pending', last_error = NULL, updated_at = now()
         WHERE status = 'failed'`,
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'CompanyProvisioningRequested',
          companyId: currentCompanyId(),
          payload: { requestedBy: actor.userId },
        }),
      ]);
    });
    return this.get(id);
  }

  /** The company the signed-in user acts for. */
  current(): Promise<CompanyProfile> {
    return this.#database.transaction(async (tx) => {
      const { rows: companies } = await tx.query<{ id: string; slug: string; name: string; status: CompanyStatus }>(
        'SELECT id, slug, name, status FROM tenancy.companies',
      );
      const company = companies[0];
      if (company === undefined) {
        throw notFound();
      }
      const { rows: resources } = await tx.query<CompanyResource>(
        'SELECT kind, status, external_name AS name, url FROM tenancy.company_resources ORDER BY kind',
      );
      return { ...company, resources };
    });
  }

  #inCompany(id: CompanyId, work: (tx: TenantTransaction) => Promise<void>): Promise<void> {
    return runWithCompany(id, () => this.#database.transaction(work));
  }
}

function companyId(value: unknown): CompanyId {
  return parseCompanyId(uuid(value));
}

const notFound = () => new TenancyError('not-found', 'This company does not exist.');

/** Row-level security limits this to the current company. */
async function lockCompany(tx: TenantTransaction): Promise<{ name: string; slug: string; status: CompanyStatus }> {
  const { rows } = await tx.query<{ name: string; slug: string; status: CompanyStatus }>(
    'SELECT name, slug, status FROM tenancy.companies FOR UPDATE',
  );
  const company = rows[0];
  if (company === undefined) {
    throw notFound();
  }
  return company;
}

function toPlatformCompany(row: PlatformCompanyRow): PlatformCompany {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    statusChangedAt: row.status_changed_at.toISOString(),
    erasedAt: row.erased_at?.toISOString() ?? null,
    memberCount: row.member_count,
    resources: row.resources,
  };
}
