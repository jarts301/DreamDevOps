import { createHash, randomBytes } from 'node:crypto';
import type { Principal } from '@dreamdevops/contracts/identity-access/access';
import { InvitationRevoked, MemberRemoved, RoleGranted, UserInvited } from '@dreamdevops/contracts/identity-access/events';
import type {
  AcceptedInvitation,
  CreatedInvitation,
  InvitationView,
  MemberView,
  RoleView,
  SentInvitation,
} from '@dreamdevops/contracts/identity-access/http';
import type { FirstAdminInvitations } from '@dreamdevops/contracts/identity-access/services';
import type { InvitationMailer } from '@dreamdevops/contracts/notifications/services';
import { currentCompanyId, isUuid, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { normalizeEmail } from '../domain/email.ts';
import { AccessError } from '../domain/errors.ts';
import type { MembershipSession, MembershipStore } from './ports.ts';

const COMPANY_ADMIN = 'company-admin';
const INVITATION_LIFETIME_DAYS = 7;

/** One message for every unusable token, so failures reveal nothing about invitations. */
const invalidInvitation = () => new AccessError('not-found', 'This invitation is not valid.');

export interface CompanyAccessOptions {
  readonly requireVerifiedEmail: boolean;
}

/** Manages who belongs to a company and with which role. Every change publishes an event. */
export class CompanyAccessService implements FirstAdminInvitations {
  readonly #store: MembershipStore;
  readonly #emails: InvitationMailer;
  readonly #options: CompanyAccessOptions;

  constructor(store: MembershipStore, emails: InvitationMailer, options: CompanyAccessOptions) {
    this.#store = store;
    this.#emails = emails;
    this.#options = options;
  }

  listRoles(): Promise<RoleView[]> {
    return this.#store.transaction((session) => session.companyRoles());
  }

  async listMembers(): Promise<MemberView[]> {
    const members = await this.#store.transaction((session) => session.members());
    return members.map((member) => ({
      userId: member.userId,
      email: member.email,
      displayName: member.displayName,
      role: member.role,
      joinedAt: member.joinedAt.toISOString(),
    }));
  }

  changeRole(actor: Principal, userIdValue: unknown, roleValue: unknown): Promise<void> {
    const userId = uuid(userIdValue);
    return this.#store.transaction(async (session) => {
      const role = await assignableRole(session, roleValue);
      const currentRole = await lockMemberRole(session, userId);
      if (currentRole === role) {
        return;
      }
      if (currentRole === COMPANY_ADMIN) {
        await assertAnotherAdminRemains(session, userId);
      }
      await session.setRole(userId, role);
      await session.record([
        RoleGranted.create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { userId, role, previousRole: currentRole, grantedBy: actor.userId },
        }),
      ]);
    });
  }

  removeMember(actor: Principal, userIdValue: unknown): Promise<void> {
    const userId = uuid(userIdValue);
    return this.#store.transaction(async (session) => {
      const currentRole = await lockMemberRole(session, userId);
      if (currentRole === COMPANY_ADMIN) {
        await assertAnotherAdminRemains(session, userId);
      }
      await session.removeMember(userId);
      await session.record([
        MemberRemoved.create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { userId, role: currentRole, removedBy: actor.userId },
        }),
      ]);
    });
  }

  /**
   * Invites someone to the current company, and emails them the link. The invitation stands
   * even if the email can't be sent, and the answer says so, so the inviter can send the link.
   * The local demo's setup sends none.
   */
  async invite(
    actor: Principal,
    emailValue: unknown,
    roleValue: unknown,
    options: { readonly sendEmail?: boolean } = {},
  ): Promise<SentInvitation> {
    const email = normalizeEmail(emailValue);
    const invitation = await this.#store.transaction(async (session) => {
      const role = await assignableRole(session, roleValue);
      if (await session.hasMemberWithEmail(email)) {
        throw new AccessError('conflict', 'This person is already a member of the company.');
      }
      return createInvitation(session, email, role, actor.userId);
    });
    if (options.sendEmail === false) {
      return { ...invitation, emailSent: false };
    }
    const emailSent = await this.#emails.send({
      to: invitation.email,
      companyName: actor.companyName ?? 'your company',
      role: invitation.role,
      invitedBy: actor.displayName,
      token: invitation.token,
      expiresAt: invitation.expiresAt,
    });
    return { ...invitation, emailSent };
  }

  async listInvitations(): Promise<InvitationView[]> {
    const invitations = await this.#store.transaction((session) => session.openInvitations());
    return invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      createdAt: invitation.createdAt.toISOString(),
      expiresAt: invitation.expiresAt.toISOString(),
    }));
  }

  revokeInvitation(actor: Principal, idValue: unknown): Promise<void> {
    const id = uuid(idValue);
    return this.#store.transaction(async (session) => {
      if (!(await session.revokeInvitation(id))) {
        throw new AccessError('not-found', 'This invitation does not exist.');
      }
      await session.record([
        InvitationRevoked.create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { invitationId: id, revokedBy: actor.userId },
        }),
      ]);
    });
  }

  /**
   * Invites a company's first admin, in that company's context, once Tenancy has made it.
   * It only works while the company has no members, so it can't become a way into company data.
   */
  inviteFirstAdmin(actor: Principal, emailValue: string): Promise<CreatedInvitation> {
    const email = normalizeEmail(emailValue);
    return this.#store.transaction(async (session) => {
      if (await session.hasMembers()) {
        throw new AccessError('conflict', 'This company already has members.');
      }
      return createInvitation(session, email, COMPANY_ADMIN, actor.userId);
    });
  }

  /** Requires both the secret token and a matching signed-in email address. */
  async acceptInvitation(principal: Principal, tokenValue: unknown): Promise<AcceptedInvitation> {
    if (typeof tokenValue !== 'string' || tokenValue === '') {
      throw invalidInvitation();
    }
    const tokenHash = hashToken(tokenValue);
    const companyId = await this.#store.invitationCompany(tokenHash);
    if (companyId === null) {
      throw invalidInvitation();
    }
    if (this.#options.requireVerifiedEmail && !principal.emailVerified) {
      throw new AccessError('invalid', 'Verify your email address before accepting an invitation.');
    }

    return runWithCompany(parseCompanyId(companyId), () =>
      this.#store.transaction(async (session) => {
        const invitation = await session.lockUsableInvitation(tokenHash);
        if (invitation === null || invitation.email !== principal.email.toLowerCase()) {
          throw invalidInvitation();
        }
        if (!(await session.addMember(companyId, principal.userId, invitation.role))) {
          throw new AccessError('conflict', 'You are already a member of this company.');
        }
        await session.markAccepted(invitation.id, principal.userId);
        await session.record([
          RoleGranted.create({
            companyId: currentCompanyId(),
            actorId: principal.userId,
            payload: { userId: principal.userId, role: invitation.role, invitationId: invitation.id },
          }),
        ]);
        return { companyId, role: invitation.role };
      }),
    );
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function uuid(value: unknown): string {
  if (!isUuid(value)) {
    throw new AccessError('invalid', 'The ID is not valid.');
  }
  return value.toLowerCase();
}

async function assignableRole(session: MembershipSession, value: unknown): Promise<string> {
  if (typeof value !== 'string' || !(await session.isCompanyRole(value))) {
    throw new AccessError('invalid', 'This role does not exist in a company.');
  }
  return value;
}

async function lockMemberRole(session: MembershipSession, userId: string): Promise<string> {
  const role = await session.lockRoleOf(userId);
  if (role === null) {
    throw new AccessError('not-found', 'This person is not a member of the company.');
  }
  return role;
}

/** Locks the company's admins, so two requests can't each remove the other's last admin. */
async function assertAnotherAdminRemains(session: MembershipSession, leavingUserId: string): Promise<void> {
  const admins = await session.lockMembersWithRole(COMPANY_ADMIN);
  if (!admins.some((admin) => admin !== leavingUserId)) {
    throw new AccessError('conflict', 'A company must keep at least one Company Admin.');
  }
}

async function createInvitation(session: MembershipSession, email: string, role: string, invitedBy: string): Promise<CreatedInvitation> {
  // An expired invitation no longer counts, so it mustn't block sending a new one.
  await session.revokeExpiredInvitations(email);
  if (await session.hasOpenInvitation(email)) {
    throw new AccessError('conflict', 'This person already has an open invitation.');
  }

  const token = randomBytes(32).toString('base64url');
  const invitation = await session.addInvitation({
    email,
    role,
    tokenHash: hashToken(token),
    invitedBy,
    lifetimeDays: INVITATION_LIFETIME_DAYS,
  });
  await session.record([
    UserInvited.create({
      companyId: currentCompanyId(),
      actorId: invitedBy,
      payload: { invitationId: invitation.id, role, invitedBy },
    }),
  ]);
  return { id: invitation.id, token, expiresAt: invitation.expiresAt.toISOString(), email, role };
}
