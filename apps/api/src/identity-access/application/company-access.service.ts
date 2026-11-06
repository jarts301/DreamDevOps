import { createHash, randomBytes } from 'node:crypto';
import { createDomainEvent, currentCompanyId, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { Pool } from 'pg';
import type { Principal } from '../domain/access.ts';
import { normalizeEmail } from '../domain/email.ts';
import { AccessError } from '../domain/errors.ts';

const COMPANY_ADMIN = 'company-admin';
const INVITATION_LIFETIME_DAYS = 7;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One message for every unusable token, so failures reveal nothing about invitations. */
const invalidInvitation = () => new AccessError('not-found', 'This invitation is not valid.');

export interface CreatedInvitation {
  readonly id: string;
  /** Shown once. Only its hash is stored. */
  readonly token: string;
  readonly expiresAt: string;
}

export interface CompanyAccessOptions {
  readonly requireVerifiedEmail: boolean;
}

/** Manages who belongs to a company and with which role. Every change publishes an event. */
export class CompanyAccessService {
  readonly #database: TenantDatabase;
  readonly #pool: Pool;
  readonly #options: CompanyAccessOptions;

  constructor(database: TenantDatabase, pool: Pool, options: CompanyAccessOptions) {
    this.#database = database;
    this.#pool = pool;
    this.#options = options;
  }

  listRoles(): Promise<object[]> {
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT r.key, r.name, coalesce(array_agg(p.permission ORDER BY p.permission), '{}') AS permissions
         FROM identity.roles r
         JOIN identity.role_permissions p ON p.role_key = r.key
         WHERE r.is_company_role
         GROUP BY r.key, r.name
         ORDER BY r.key`,
      );
      return rows;
    });
  }

  listMembers(): Promise<object[]> {
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT user_id AS "userId", email, display_name AS "displayName", role_key AS role, joined_at AS "joinedAt"
         FROM identity.company_members()`,
      );
      return rows;
    });
  }

  changeRole(actor: Principal, userIdValue: unknown, roleValue: unknown): Promise<void> {
    const userId = uuid(userIdValue);
    return this.#database.transaction(async (tx) => {
      const role = await assignableRole(tx, roleValue);
      const currentRole = await lockMemberRole(tx, userId);
      if (currentRole === role) {
        return;
      }
      if (currentRole === COMPANY_ADMIN) {
        await assertAnotherAdminRemains(tx, userId);
      }
      await tx.query('UPDATE identity.memberships SET role_key = $2 WHERE user_id = $1', [userId, role]);
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'RoleGranted',
          companyId: currentCompanyId(),
          payload: { userId, role, previousRole: currentRole, grantedBy: actor.userId },
        }),
      ]);
    });
  }

  removeMember(actor: Principal, userIdValue: unknown): Promise<void> {
    const userId = uuid(userIdValue);
    return this.#database.transaction(async (tx) => {
      const currentRole = await lockMemberRole(tx, userId);
      if (currentRole === COMPANY_ADMIN) {
        await assertAnotherAdminRemains(tx, userId);
      }
      await tx.query('DELETE FROM identity.memberships WHERE user_id = $1', [userId]);
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'MemberRemoved',
          companyId: currentCompanyId(),
          payload: { userId, role: currentRole, removedBy: actor.userId },
        }),
      ]);
    });
  }

  invite(actor: Principal, emailValue: unknown, roleValue: unknown): Promise<CreatedInvitation> {
    const email = normalizeEmail(emailValue);
    return this.#database.transaction(async (tx) => {
      const role = await assignableRole(tx, roleValue);
      const { rows: members } = await tx.query('SELECT 1 FROM identity.company_members() WHERE email = $1', [email]);
      if (members.length > 0) {
        throw new AccessError('conflict', 'This person is already a member of the company.');
      }
      return createInvitation(tx, email, role, actor.userId);
    });
  }

  listInvitations(): Promise<object[]> {
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, email, role_key AS role, created_at AS "createdAt", expires_at AS "expiresAt"
         FROM identity.invitations
         WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
         ORDER BY created_at, id`,
      );
      return rows;
    });
  }

  revokeInvitation(actor: Principal, idValue: unknown): Promise<void> {
    const id = uuid(idValue);
    return this.#database.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        'UPDATE identity.invitations SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL',
        [id],
      );
      if (rowCount === 0) {
        throw new AccessError('not-found', 'This invitation does not exist.');
      }
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'InvitationRevoked',
          companyId: currentCompanyId(),
          payload: { invitationId: id, revokedBy: actor.userId },
        }),
      ]);
    });
  }

  /**
   * Invites a company's first admin, inside the Tenancy module's transaction and in that
   * company's context. It only works while the company has no members, so it can't
   * become a way into company data.
   */
  async inviteFirstAdminIn(tx: TenantTransaction, actor: Principal, emailValue: unknown): Promise<CreatedInvitation> {
    const email = normalizeEmail(emailValue);
    const { rows } = await tx.query('SELECT 1 FROM identity.memberships LIMIT 1');
    if (rows.length > 0) {
      throw new AccessError('conflict', 'This company already has members.');
    }
    return createInvitation(tx, email, COMPANY_ADMIN, actor.userId);
  }

  /** Requires both the secret token and a matching signed-in email address. */
  async acceptInvitation(principal: Principal, tokenValue: unknown): Promise<{ companyId: string; role: string }> {
    if (typeof tokenValue !== 'string' || tokenValue === '') {
      throw invalidInvitation();
    }
    const tokenHash = hashToken(tokenValue);
    const { rows } = await this.#pool.query<{ company_id: string | null }>(
      'SELECT identity.invitation_company($1) AS company_id',
      [tokenHash],
    );
    const companyId = rows[0]?.company_id;
    if (companyId === null || companyId === undefined) {
      throw invalidInvitation();
    }
    if (this.#options.requireVerifiedEmail && !principal.emailVerified) {
      throw new AccessError('invalid', 'Verify your email address before accepting an invitation.');
    }

    return runWithCompany(parseCompanyId(companyId), () =>
      this.#database.transaction(async (tx) => {
        const { rows: invitations } = await tx.query<{ id: string; email: string; role_key: string }>(
          `SELECT id, email, role_key
           FROM identity.invitations
           WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
           FOR UPDATE`,
          [tokenHash],
        );
        const invitation = invitations[0];
        if (invitation === undefined || invitation.email !== principal.email.toLowerCase()) {
          throw invalidInvitation();
        }

        const { rowCount } = await tx.query(
          `INSERT INTO identity.memberships (company_id, user_id, role_key)
           VALUES ($1, $2, $3)
           ON CONFLICT (company_id, user_id) DO NOTHING`,
          [companyId, principal.userId, invitation.role_key],
        );
        if (rowCount === 0) {
          throw new AccessError('conflict', 'You are already a member of this company.');
        }
        await tx.query('UPDATE identity.invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [
          invitation.id,
          principal.userId,
        ]);
        await appendToOutbox(tx, [
          createDomainEvent({
            eventType: 'RoleGranted',
            companyId: currentCompanyId(),
            payload: { userId: principal.userId, role: invitation.role_key, invitationId: invitation.id },
          }),
        ]);
        return { companyId, role: invitation.role_key };
      }),
    );
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AccessError('invalid', 'The ID is not valid.');
  }
  return value.toLowerCase();
}

async function assignableRole(tx: TenantTransaction, value: unknown): Promise<string> {
  const { rows } = await tx.query('SELECT 1 FROM identity.roles WHERE key = $1 AND is_company_role', [
    typeof value === 'string' ? value : '',
  ]);
  if (rows.length === 0) {
    throw new AccessError('invalid', 'This role does not exist in a company.');
  }
  return value as string;
}

async function lockMemberRole(tx: TenantTransaction, userId: string): Promise<string> {
  const { rows } = await tx.query<{ role_key: string }>(
    'SELECT role_key FROM identity.memberships WHERE user_id = $1 FOR UPDATE',
    [userId],
  );
  const member = rows[0];
  if (member === undefined) {
    throw new AccessError('not-found', 'This person is not a member of the company.');
  }
  return member.role_key;
}

/** Locks the company's admins, so two requests can't each remove the other's last admin. */
async function assertAnotherAdminRemains(tx: TenantTransaction, leavingUserId: string): Promise<void> {
  const { rows } = await tx.query<{ user_id: string }>(
    'SELECT user_id FROM identity.memberships WHERE role_key = $1 ORDER BY user_id FOR UPDATE',
    [COMPANY_ADMIN],
  );
  if (!rows.some((admin) => admin.user_id !== leavingUserId)) {
    throw new AccessError('conflict', 'A company must keep at least one Company Admin.');
  }
}

async function createInvitation(
  tx: TenantTransaction,
  email: string,
  role: string,
  invitedBy: string,
): Promise<CreatedInvitation> {
  // An expired invitation no longer counts, so it mustn't block sending a new one.
  await tx.query(
    `UPDATE identity.invitations SET revoked_at = now()
     WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()`,
    [email],
  );
  const { rows: open } = await tx.query(
    'SELECT 1 FROM identity.invitations WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL',
    [email],
  );
  if (open.length > 0) {
    throw new AccessError('conflict', 'This person already has an open invitation.');
  }

  const token = randomBytes(32).toString('base64url');
  const { rows } = await tx.query<{ id: string; expires_at: Date }>(
    `INSERT INTO identity.invitations (company_id, email, role_key, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
     RETURNING id, expires_at`,
    [currentCompanyId(), email, role, hashToken(token), invitedBy, INVITATION_LIFETIME_DAYS],
  );
  const invitation = rows[0]!;
  await appendToOutbox(tx, [
    createDomainEvent({
      eventType: 'UserInvited',
      companyId: currentCompanyId(),
      payload: { invitationId: invitation.id, role, invitedBy },
    }),
  ]);
  return { id: invitation.id, token, expiresAt: invitation.expires_at.toISOString() };
}
