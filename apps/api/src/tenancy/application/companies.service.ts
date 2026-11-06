import { randomUUID } from 'node:crypto';
import { type CompanyId, createDomainEvent, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { Principal } from '../../identity-access/domain/access.ts';
import {
  CompanyAccessService,
  type CreatedInvitation,
} from '../../identity-access/application/company-access.service.ts';
import { normalizeEmail } from '../../identity-access/domain/email.ts';
import { type CompanyStatus, normalizeCompanyName, numberedSlug, slugFromName } from '../domain/company.ts';
import { TenancyError } from '../domain/errors.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CompanySummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: CompanyStatus;
  readonly createdAt: string;
  readonly provisioningError: string | null;
}

/** The platform's register of companies. Only platform admins reach it. */
export class CompaniesService {
  readonly #database: TenantDatabase;
  readonly #access: CompanyAccessService;

  constructor(database: TenantDatabase, access: CompanyAccessService) {
    this.#database = database;
    this.#access = access;
  }

  /** Lists companies without entering any of them, so it reveals no company data. */
  async list(): Promise<CompanySummary[]> {
    return this.#platform(async (tx) => {
      const { rows } = await tx.query<CompanySummary>(
        `SELECT c.id, c.name, c.slug, c.status, c.created_at AS "createdAt",
                (SELECT r.last_error FROM tenancy.company_resources r
                 WHERE r.company_id = c.id AND r.status = 'failed' LIMIT 1) AS "provisioningError"
         FROM tenancy.companies c
         ORDER BY lower(c.name)`,
      );
      return rows;
    });
  }

  /**
   * Creates the company and invites its first admin in one transaction, so a company
   * can't exist without a way in. Its resources are provisioned in the background.
   */
  async create(
    actor: Principal,
    nameValue: unknown,
    emailValue: unknown,
  ): Promise<{ company: CompanySummary; invitation: CreatedInvitation }> {
    const name = normalizeCompanyName(nameValue);
    const email = normalizeEmail(emailValue);
    const companyId = parseCompanyId(randomUUID());

    return runWithCompany(companyId, () =>
      this.#database.transaction(async (tx) => {
        await assertNameFree(tx, name, null);
        const slug = await freeSlug(tx, slugFromName(name));
        const { rows } = await tx.query<{ created_at: Date }>(
          `INSERT INTO tenancy.companies (id, name, slug, status, created_by)
           VALUES ($1, $2, $3, 'provisioning', $4)
           RETURNING created_at`,
          [companyId, name, slug, actor.userId],
        );
        await appendToOutbox(tx, [
          createDomainEvent({ eventType: 'CompanyCreated', companyId, payload: { name, slug, createdBy: actor.userId } }),
        ]);
        const invitation = await this.#access.inviteFirstAdminIn(tx, actor, email);
        return {
          company: {
            id: companyId,
            name,
            slug,
            status: 'provisioning' as const,
            createdAt: rows[0]!.created_at.toISOString(),
            provisioningError: null,
          },
          invitation,
        };
      }),
    );
  }

  rename(actor: Principal, idValue: unknown, nameValue: unknown): Promise<void> {
    const name = normalizeCompanyName(nameValue);
    return this.#inCompany(idValue, async (tx, companyId, current) => {
      if (current.name === name) {
        return;
      }
      await assertNameFree(tx, name, companyId);
      await tx.query('UPDATE tenancy.companies SET name = $2, updated_at = now() WHERE id = $1', [companyId, name]);
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'CompanyRenamed',
          companyId,
          payload: { name, previousName: current.name, renamedBy: actor.userId },
        }),
      ]);
    });
  }

  /** Blocks every member's access at once, and keeps all data, so it can be undone. */
  suspend(actor: Principal, idValue: unknown): Promise<void> {
    return this.#inCompany(idValue, async (tx, companyId, current) => {
      if (current.status === 'suspended') {
        return;
      }
      await tx.query(
        "UPDATE tenancy.companies SET status = 'suspended', suspended_at = now(), updated_at = now() WHERE id = $1",
        [companyId],
      );
      await appendToOutbox(tx, [
        createDomainEvent({ eventType: 'CompanySuspended', companyId, payload: { suspendedBy: actor.userId } }),
      ]);
    });
  }

  /** Restores access, then checks the company's resources, which may have changed meanwhile. */
  reactivate(actor: Principal, idValue: unknown): Promise<void> {
    return this.#inCompany(idValue, async (tx, companyId, current) => {
      if (current.status !== 'suspended') {
        return;
      }
      await tx.query(
        "UPDATE tenancy.companies SET status = 'provisioning', suspended_at = NULL, updated_at = now() WHERE id = $1",
        [companyId],
      );
      await appendToOutbox(tx, [
        createDomainEvent({ eventType: 'CompanyReactivated', companyId, payload: { reactivatedBy: actor.userId } }),
        createDomainEvent({ eventType: 'CompanyProvisioningRequested', companyId, payload: {} }),
      ]);
    });
  }

  /** Tries provisioning again, such as after fixing what made it fail. */
  retryProvisioning(actor: Principal, idValue: unknown): Promise<void> {
    return this.#inCompany(idValue, async (tx, companyId, current) => {
      if (current.status === 'suspended') {
        throw new TenancyError('conflict', 'Reactivate the company first.');
      }
      await tx.query(
        "UPDATE tenancy.company_resources SET attempts = 0, status = 'pending', updated_at = now() WHERE company_id = $1",
        [companyId],
      );
      if (current.status === 'provisioning-failed') {
        await tx.query("UPDATE tenancy.companies SET status = 'provisioning', updated_at = now() WHERE id = $1", [
          companyId,
        ]);
      }
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'CompanyProvisioningRequested',
          companyId,
          payload: { requestedBy: actor.userId },
        }),
      ]);
    });
  }

  /** Sends a new first-admin invitation, such as when the first one was lost. */
  inviteFirstAdmin(actor: Principal, idValue: unknown, emailValue: unknown): Promise<CreatedInvitation> {
    const email = normalizeEmail(emailValue);
    return this.#inCompany(idValue, async (tx, _companyId, current) => {
      if (current.status === 'suspended') {
        throw new TenancyError('conflict', 'Reactivate the company first.');
      }
      return this.#access.inviteFirstAdminIn(tx, actor, email);
    });
  }

  /** Runs work for one company, after checking it exists and locking it. */
  #inCompany<T>(
    idValue: unknown,
    work: (tx: TenantTransaction, companyId: CompanyId, current: { name: string; status: CompanyStatus }) => Promise<T>,
  ): Promise<T> {
    if (typeof idValue !== 'string' || !UUID_PATTERN.test(idValue)) {
      throw new TenancyError('invalid', 'The company ID is not valid.');
    }
    const companyId = parseCompanyId(idValue);
    return runWithCompany(companyId, () =>
      this.#database.transaction(async (tx) => {
        const { rows } = await tx.query<{ name: string; status: CompanyStatus }>(
          'SELECT name, status FROM tenancy.companies WHERE id = $1 FOR UPDATE',
          [companyId],
        );
        if (rows[0] === undefined) {
          throw new TenancyError('not-found', 'This company does not exist.');
        }
        return work(tx, companyId, rows[0]);
      }),
    );
  }

  /** Platform-level reads use a placeholder company, which matches no company's data. */
  #platform<T>(work: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return runWithCompany(parseCompanyId('00000000-0000-0000-0000-000000000000'), () =>
      this.#database.transaction(work),
    );
  }
}

async function assertNameFree(tx: TenantTransaction, name: string, exceptId: string | null): Promise<void> {
  const { rows } = await tx.query('SELECT 1 FROM tenancy.companies WHERE lower(name) = lower($1) AND id <> $2', [
    name,
    exceptId ?? '00000000-0000-0000-0000-000000000000',
  ]);
  if (rows.length > 0) {
    throw new TenancyError('conflict', 'Another company already has this name.');
  }
}

async function freeSlug(tx: TenantTransaction, base: string): Promise<string> {
  for (let number = 1; number <= 100; number += 1) {
    const candidate = number === 1 ? base : numberedSlug(base, number);
    const { rows } = await tx.query('SELECT 1 FROM tenancy.companies WHERE slug = $1', [candidate]);
    if (rows.length === 0) {
      return candidate;
    }
  }
  throw new TenancyError('conflict', 'Too many companies have a similar name.');
}
