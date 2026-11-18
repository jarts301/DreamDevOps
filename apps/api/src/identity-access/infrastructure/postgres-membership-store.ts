import { currentCompanyId } from '@dreamdevops/shared-kernel';
import { PostgresSession, type TenantDatabase, transactional } from '@dreamdevops/shared-kernel/postgres';
import type { Pool } from 'pg';
import type {
  CompanyRole,
  MembershipSession,
  MembershipStore,
  NewInvitation,
  OpenInvitation,
  StoredMember,
} from '../application/ports.ts';

interface MemberRow {
  user_id: string;
  email: string;
  display_name: string;
  role_key: string;
  joined_at: Date;
}

/**
 * Members and invitations, in the identity schema. Member details come through
 * identity.company_members(), which answers for the current company only.
 */
export function postgresMembershipStore(database: TenantDatabase, pool: Pool): MembershipStore {
  return {
    ...transactional(database, (tx) => new PostgresMembershipSession(tx)),
    async invitationCompany(tokenHash: string): Promise<string | null> {
      const { rows } = await pool.query<{ company_id: string | null }>('SELECT identity.invitation_company($1) AS company_id', [
        tokenHash,
      ]);
      return rows[0]?.company_id ?? null;
    },
  };
}

class PostgresMembershipSession extends PostgresSession implements MembershipSession {
  async companyRoles(): Promise<CompanyRole[]> {
    const { rows } = await this.tx.query<CompanyRole>(
      `SELECT r.key, r.name, coalesce(array_agg(p.permission ORDER BY p.permission), '{}') AS permissions
       FROM identity.roles r
       JOIN identity.role_permissions p ON p.role_key = r.key
       WHERE r.is_company_role
       GROUP BY r.key, r.name
       ORDER BY r.key`,
    );
    return rows;
  }

  async isCompanyRole(key: string): Promise<boolean> {
    const { rows } = await this.tx.query('SELECT 1 FROM identity.roles WHERE key = $1 AND is_company_role', [key]);
    return rows.length > 0;
  }

  async members(): Promise<StoredMember[]> {
    const { rows } = await this.tx.query<MemberRow>('SELECT user_id, email, display_name, role_key, joined_at FROM identity.company_members()');
    return rows.map(toMember);
  }

  async membersByName(userIds: readonly string[] | null): Promise<StoredMember[]> {
    const { rows } = await this.tx.query<MemberRow>(
      `SELECT user_id, email, display_name, role_key, joined_at FROM identity.company_members()
       WHERE $1::uuid[] IS NULL OR user_id = ANY ($1::uuid[])
       ORDER BY lower(display_name), user_id`,
      [userIds],
    );
    return rows.map(toMember);
  }

  async hasMembers(): Promise<boolean> {
    const { rows } = await this.tx.query('SELECT 1 FROM identity.memberships LIMIT 1');
    return rows.length > 0;
  }

  async hasMemberWithEmail(email: string): Promise<boolean> {
    const { rows } = await this.tx.query('SELECT 1 FROM identity.company_members() WHERE email = $1', [email]);
    return rows.length > 0;
  }

  async lockRoleOf(userId: string): Promise<string | null> {
    const { rows } = await this.tx.query<{ role_key: string }>('SELECT role_key FROM identity.memberships WHERE user_id = $1 FOR UPDATE', [
      userId,
    ]);
    return rows[0]?.role_key ?? null;
  }

  async lockMembersWithRole(role: string): Promise<string[]> {
    const { rows } = await this.tx.query<{ user_id: string }>(
      'SELECT user_id FROM identity.memberships WHERE role_key = $1 ORDER BY user_id FOR UPDATE',
      [role],
    );
    return rows.map((row) => row.user_id);
  }

  async setRole(userId: string, role: string): Promise<void> {
    await this.tx.query('UPDATE identity.memberships SET role_key = $2 WHERE user_id = $1', [userId, role]);
  }

  async removeMember(userId: string): Promise<void> {
    await this.tx.query('DELETE FROM identity.memberships WHERE user_id = $1', [userId]);
  }

  async addMember(companyId: string, userId: string, role: string): Promise<boolean> {
    const { rowCount } = await this.tx.query(
      `INSERT INTO identity.memberships (company_id, user_id, role_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, user_id) DO NOTHING`,
      [companyId, userId, role],
    );
    return rowCount !== 0;
  }

  async openInvitations(): Promise<OpenInvitation[]> {
    const { rows } = await this.tx.query<{ id: string; email: string; role_key: string; created_at: Date; expires_at: Date }>(
      `SELECT id, email, role_key, created_at, expires_at
       FROM identity.invitations
       WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at, id`,
    );
    return rows.map((row) => ({ id: row.id, email: row.email, role: row.role_key, createdAt: row.created_at, expiresAt: row.expires_at }));
  }

  async revokeInvitation(id: string): Promise<boolean> {
    const { rowCount } = await this.tx.query(
      'UPDATE identity.invitations SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL',
      [id],
    );
    return rowCount !== 0;
  }

  async revokeExpiredInvitations(email: string): Promise<void> {
    await this.tx.query(
      `UPDATE identity.invitations SET revoked_at = now()
       WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()`,
      [email],
    );
  }

  async hasOpenInvitation(email: string): Promise<boolean> {
    const { rows } = await this.tx.query('SELECT 1 FROM identity.invitations WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL', [
      email,
    ]);
    return rows.length > 0;
  }

  async addInvitation(invitation: NewInvitation): Promise<{ readonly id: string; readonly expiresAt: Date }> {
    const { rows } = await this.tx.query<{ id: string; expires_at: Date }>(
      `INSERT INTO identity.invitations (company_id, email, role_key, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
       RETURNING id, expires_at`,
      [currentCompanyId(), invitation.email, invitation.role, invitation.tokenHash, invitation.invitedBy, invitation.lifetimeDays],
    );
    return { id: rows[0]!.id, expiresAt: rows[0]!.expires_at };
  }

  async lockUsableInvitation(tokenHash: string): Promise<{ readonly id: string; readonly email: string; readonly role: string } | null> {
    const { rows } = await this.tx.query<{ id: string; email: string; role_key: string }>(
      `SELECT id, email, role_key
       FROM identity.invitations
       WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       FOR UPDATE`,
      [tokenHash],
    );
    return rows[0] === undefined ? null : { id: rows[0].id, email: rows[0].email, role: rows[0].role_key };
  }

  async markAccepted(invitationId: string, userId: string): Promise<void> {
    await this.tx.query('UPDATE identity.invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [invitationId, userId]);
  }
}

function toMember(row: MemberRow): StoredMember {
  return { userId: row.user_id, email: row.email, displayName: row.display_name, role: row.role_key, joinedAt: row.joined_at };
}
