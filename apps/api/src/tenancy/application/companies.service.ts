import { randomUUID } from 'node:crypto';
import {
  CompanyCreated,
  CompanyProvisioningRequested,
  CompanyReactivated,
  CompanyRenamed,
  CompanySuspended,
} from '@dreamdevops/contracts/tenancy/events';
import { type CompanyId, isUuid, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import { normalizedEmail, type Principal } from '@dreamdevops/contracts/identity-access/access';
import type { CreatedInvitation } from '@dreamdevops/contracts/identity-access/http';
import type { FirstAdminInvitations } from '@dreamdevops/contracts/identity-access/services';
import type { CompanySummary } from '@dreamdevops/contracts/tenancy/http';
import { type CompanyStatus, normalizeCompanyName, numberedSlug, slugFromName } from '../domain/company.ts';
import { TenancyError } from '../domain/errors.ts';

/** The platform's register of companies. Only platform admins reach it. */
export class CompaniesService {
  readonly #database: TenantDatabase;
  readonly #invitations: FirstAdminInvitations;

  constructor(database: TenantDatabase, invitations: FirstAdminInvitations) {
    this.#database = database;
    this.#invitations = invitations;
  }

  /** Lists companies without entering any of them, so it reveals no company data. */
  async list(): Promise<CompanySummary[]> {
    return this.#platform(async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        name: string;
        slug: string;
        status: CompanyStatus;
        created_at: Date;
        provisioning_error: string | null;
      }>(
        `SELECT c.id, c.name, c.slug, c.status, c.created_at,
                (SELECT r.last_error FROM tenancy.company_resources r
                 WHERE r.company_id = c.id AND r.status = 'failed' LIMIT 1) AS provisioning_error
         FROM tenancy.companies c
         ORDER BY lower(c.name)`,
      );
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        provisioningError: row.provisioning_error,
      }));
    });
  }

  /**
   * Creates the company, then has Identity and access invite its first admin, in the new
   * company. The two are separate steps, as Identity and access keeps its own data. Should
   * the invitation fail after the company is made, a platform admin invites its first admin
   * again. Its resources are provisioned in the background.
   */
  async create(
    actor: Principal,
    nameValue: unknown,
    emailValue: unknown,
  ): Promise<{ company: CompanySummary; invitation: CreatedInvitation }> {
    const name = normalizeCompanyName(nameValue);
    const email = firstAdminEmail(emailValue);
    const companyId = parseCompanyId(randomUUID());

    const company = await runWithCompany(companyId, () =>
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
          CompanyCreated.create({ companyId, actorId: actor.userId, payload: { name, slug, createdBy: actor.userId } }),
        ]);
        return {
          id: companyId,
          name,
          slug,
          status: 'provisioning' as const,
          createdAt: rows[0]!.created_at.toISOString(),
          provisioningError: null,
        };
      }),
    );
    const invitation = await runWithCompany(companyId, () => this.#invitations.inviteFirstAdmin(actor, email));
    return { company, invitation };
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
        CompanyRenamed.create({
          companyId,
          actorId: actor.userId,
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
        CompanySuspended.create({ companyId, actorId: actor.userId, payload: { suspendedBy: actor.userId } }),
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
        CompanyReactivated.create({ companyId, actorId: actor.userId, payload: { reactivatedBy: actor.userId } }),
        CompanyProvisioningRequested.create({ companyId, actorId: actor.userId, payload: {} }),
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
        CompanyProvisioningRequested.create({
          companyId,
          actorId: actor.userId,
          payload: { requestedBy: actor.userId },
        }),
      ]);
    });
  }

  /** Sends a new first-admin invitation, such as when the first one was lost. */
  async inviteFirstAdmin(
    actor: Principal,
    idValue: unknown,
    emailValue: unknown,
  ): Promise<{ invitation: CreatedInvitation; companyName: string }> {
    const email = firstAdminEmail(emailValue);
    const { companyId, companyName } = await this.#inCompany(idValue, async (_tx, companyId, current) => {
      if (current.status === 'suspended') {
        throw new TenancyError('conflict', 'Reactivate the company first.');
      }
      return { companyId, companyName: current.name };
    });
    return { invitation: await runWithCompany(companyId, () => this.#invitations.inviteFirstAdmin(actor, email)), companyName };
  }

  /** Runs work for one company, after checking it exists and locking it. */
  #inCompany<T>(
    idValue: unknown,
    work: (tx: TenantTransaction, companyId: CompanyId, current: { name: string; status: CompanyStatus }) => Promise<T>,
  ): Promise<T> {
    if (!isUuid(idValue)) {
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

/** The first admin's address, checked before the company is made, so a typo doesn't leave a company without a way in. */
function firstAdminEmail(value: unknown): string {
  const email = normalizedEmail(value);
  if (email === null) {
    throw new TenancyError('invalid', 'Enter a valid email address.');
  }
  return email;
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
