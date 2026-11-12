import { isUuid } from '@dreamdevops/shared-kernel';
import type { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type { CompanyMember, CompanyMembers } from './company-members.ts';

const SELECT_MEMBERS = `
  SELECT user_id AS "userId", display_name AS "displayName", email, role_key AS role
  FROM identity.company_members()`;

/** Answers CompanyMembers from the memberships, in the current company only. */
export class MemberDirectory implements CompanyMembers {
  readonly #database: TenantDatabase;

  constructor(database: TenantDatabase) {
    this.#database = database;
  }

  list(): Promise<CompanyMember[]> {
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<CompanyMember>(`${SELECT_MEMBERS} ORDER BY lower(display_name), user_id`);
      return rows;
    });
  }

  async find(userIds: readonly string[]): Promise<CompanyMember[]> {
    const ids = [...new Set(userIds.filter((id) => isUuid(id)).map((id) => id.toLowerCase()))];
    if (ids.length === 0) {
      return [];
    }
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<CompanyMember>(
        `${SELECT_MEMBERS} WHERE user_id = ANY ($1::uuid[]) ORDER BY lower(display_name), user_id`,
        [ids],
      );
      return rows;
    });
  }
}
