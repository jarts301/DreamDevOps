import { randomUUID } from 'node:crypto';
import { normalizedEmail, type Principal } from '@dreamdevops/contracts/identity-access/access';
import type { CreatedInvitation, SentInvitation } from '@dreamdevops/contracts/identity-access/http';
import type { FirstAdminInvitations } from '@dreamdevops/contracts/identity-access/services';
import type { InvitationMailer } from '@dreamdevops/contracts/notifications/services';
import {
  CompanyCreated,
  CompanyProvisioningRequested,
  CompanyReactivated,
  CompanyRenamed,
  CompanySuspended,
} from '@dreamdevops/contracts/tenancy/events';
import type { CompanySummary, CreatedCompany } from '@dreamdevops/contracts/tenancy/http';
import { type CompanyId, isUuid, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { normalizeCompanyName, numberedSlug, slugFromName } from '../domain/company.ts';
import { TenancyError } from '../domain/errors.ts';
import type { StoredCompany, TenancySession, TenancyStore } from './ports.ts';

/** Whether an invitation is emailed. The local demo's setup sends none. */
export interface InvitationDelivery {
  readonly sendEmail?: boolean;
}

/** The platform's register of companies. Only platform admins reach it. */
export class CompaniesService {
  readonly #store: TenancyStore;
  readonly #invitations: FirstAdminInvitations;
  readonly #emails: InvitationMailer;

  constructor(store: TenancyStore, invitations: FirstAdminInvitations, emails: InvitationMailer) {
    this.#store = store;
    this.#invitations = invitations;
    this.#emails = emails;
  }

  /** Lists companies without entering any of them, so it reveals no company data. */
  async list(): Promise<CompanySummary[]> {
    const companies = await this.#platform((session) => session.listCompanies());
    return companies.map((company) => ({
      id: company.id,
      name: company.name,
      slug: company.slug,
      status: company.status,
      createdAt: company.createdAt.toISOString(),
      provisioningError: company.provisioningError,
    }));
  }

  /**
   * Creates the company, then has Identity and access invite its first admin, in the new
   * company, and emails them the link. The two are separate steps, as Identity and access
   * keeps its own data. Should the invitation fail after the company is made, a platform
   * admin invites its first admin again. Its resources are provisioned in the background.
   */
  async create(actor: Principal, nameValue: unknown, emailValue: unknown, delivery: InvitationDelivery = {}): Promise<CreatedCompany> {
    const name = normalizeCompanyName(nameValue);
    const email = firstAdminEmail(emailValue);
    const companyId = parseCompanyId(randomUUID());

    const company = await runWithCompany(companyId, () =>
      this.#store.transaction(async (session) => {
        await assertNameFree(session, name, null);
        const slug = await freeSlug(session, slugFromName(name));
        const createdAt = await session.addCompany({ id: companyId, name, slug, createdBy: actor.userId });
        await session.record([
          CompanyCreated.create({ companyId, actorId: actor.userId, payload: { name, slug, createdBy: actor.userId } }),
        ]);
        return {
          id: companyId,
          name,
          slug,
          status: 'provisioning' as const,
          createdAt: createdAt.toISOString(),
          provisioningError: null,
        };
      }),
    );
    const invitation = await runWithCompany(companyId, () => this.#invitations.inviteFirstAdmin(actor, email));
    return { company, invitation: await this.#deliver(actor, invitation, company.name, delivery) };
  }

  rename(actor: Principal, idValue: unknown, nameValue: unknown): Promise<void> {
    const name = normalizeCompanyName(nameValue);
    return this.#inCompany(idValue, async (session, companyId, current) => {
      if (current.name === name) {
        return;
      }
      await assertNameFree(session, name, companyId);
      await session.rename(companyId, name);
      await session.record([
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
    return this.#inCompany(idValue, async (session, companyId, current) => {
      if (current.status === 'suspended') {
        return;
      }
      await session.suspend(companyId);
      await session.record([CompanySuspended.create({ companyId, actorId: actor.userId, payload: { suspendedBy: actor.userId } })]);
    });
  }

  /** Restores access, then checks the company's resources, which may have changed meanwhile. */
  reactivate(actor: Principal, idValue: unknown): Promise<void> {
    return this.#inCompany(idValue, async (session, companyId, current) => {
      if (current.status !== 'suspended') {
        return;
      }
      await session.reactivate(companyId);
      await session.record([
        CompanyReactivated.create({ companyId, actorId: actor.userId, payload: { reactivatedBy: actor.userId } }),
        CompanyProvisioningRequested.create({ companyId, actorId: actor.userId, payload: {} }),
      ]);
    });
  }

  /** Tries provisioning again, such as after fixing what made it fail. */
  retryProvisioning(actor: Principal, idValue: unknown): Promise<void> {
    return this.#inCompany(idValue, async (session, companyId, current) => {
      if (current.status === 'suspended') {
        throw new TenancyError('conflict', 'Reactivate the company first.');
      }
      await session.resetResources(companyId);
      if (current.status === 'provisioning-failed') {
        await session.setStatus(companyId, 'provisioning');
      }
      await session.record([
        CompanyProvisioningRequested.create({
          companyId,
          actorId: actor.userId,
          payload: { requestedBy: actor.userId },
        }),
      ]);
    });
  }

  /** Sends a new first-admin invitation, such as when the first one was lost, and emails its link. */
  async inviteFirstAdmin(actor: Principal, idValue: unknown, emailValue: unknown, delivery: InvitationDelivery = {}): Promise<SentInvitation> {
    const email = firstAdminEmail(emailValue);
    const { companyId, companyName } = await this.#inCompany(idValue, async (_session, companyId, current) => {
      if (current.status === 'suspended') {
        throw new TenancyError('conflict', 'Reactivate the company first.');
      }
      return { companyId, companyName: current.name };
    });
    const invitation = await runWithCompany(companyId, () => this.#invitations.inviteFirstAdmin(actor, email));
    return this.#deliver(actor, invitation, companyName, delivery);
  }

  /** Emails an invitation's link. The invitation stands even if the email can't be sent, and the answer says so. */
  async #deliver(actor: Principal, invitation: CreatedInvitation, companyName: string, delivery: InvitationDelivery): Promise<SentInvitation> {
    if (delivery.sendEmail === false) {
      return { ...invitation, emailSent: false };
    }
    const emailSent = await this.#emails.send({
      to: invitation.email,
      companyName,
      role: invitation.role,
      invitedBy: actor.displayName,
      token: invitation.token,
      expiresAt: invitation.expiresAt,
    });
    return { ...invitation, emailSent };
  }

  /** Runs work for one company, after checking it exists and locking it. */
  #inCompany<T>(
    idValue: unknown,
    work: (session: TenancySession, companyId: CompanyId, current: StoredCompany) => Promise<T>,
  ): Promise<T> {
    if (!isUuid(idValue)) {
      throw new TenancyError('invalid', 'The company ID is not valid.');
    }
    const companyId = parseCompanyId(idValue);
    return runWithCompany(companyId, () =>
      this.#store.transaction(async (session) => {
        const current = await session.lockCompany(companyId);
        if (current === null) {
          throw new TenancyError('not-found', 'This company does not exist.');
        }
        return work(session, companyId, current);
      }),
    );
  }

  /** Platform-level reads use a placeholder company, which matches no company's data. */
  #platform<T>(work: (session: TenancySession) => Promise<T>): Promise<T> {
    return runWithCompany(parseCompanyId('00000000-0000-0000-0000-000000000000'), () => this.#store.transaction(work));
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

async function assertNameFree(session: TenancySession, name: string, exceptId: string | null): Promise<void> {
  if (await session.isNameTaken(name, exceptId)) {
    throw new TenancyError('conflict', 'Another company already has this name.');
  }
}

async function freeSlug(session: TenancySession, base: string): Promise<string> {
  for (let number = 1; number <= 100; number += 1) {
    const candidate = number === 1 ? base : numberedSlug(base, number);
    if (!(await session.isSlugTaken(candidate))) {
      return candidate;
    }
  }
  throw new TenancyError('conflict', 'Too many companies have a similar name.');
}
