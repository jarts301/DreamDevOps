import type { Queryable } from '@dreamdevops/shared-kernel/postgres';
import type { UserAccess } from '../domain/access.ts';
import type { ExternalIdentity, UserDirectory } from '../application/ports.ts';

/**
 * People and their access across companies, which every request reads before any company is
 * chosen. It reads through functions made for that, as Identity and access's own role.
 */
export class PostgresUserDirectory implements UserDirectory {
  readonly #pool: Queryable;

  constructor(pool: Queryable) {
    this.#pool = pool;
  }

  async recordLogin(identity: ExternalIdentity): Promise<string> {
    const { rows } = await this.#pool.query<{ id: string }>(
      'SELECT identity.record_login($1, $2, $3, $4, $5) AS id',
      [identity.subject, identity.email, identity.emailVerified, identity.displayName, identity.platformAdmin],
    );
    return rows[0]!.id;
  }

  async loadAccess(userId: string): Promise<UserAccess | null> {
    const { rows } = await this.#pool.query<{ access: UserAccess | null }>(
      'SELECT identity.user_access($1) AS access',
      [userId],
    );
    return rows[0]?.access ?? null;
  }
}
