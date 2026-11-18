import type { CompanyMember, CompanyMembers } from '@dreamdevops/contracts/identity-access/services';
import { isUuid } from '@dreamdevops/shared-kernel';
import type { MembershipStore, StoredMember } from './ports.ts';

/** Answers CompanyMembers from the memberships, in the current company only. */
export class MemberDirectory implements CompanyMembers {
  readonly #store: MembershipStore;

  constructor(store: MembershipStore) {
    this.#store = store;
  }

  async list(): Promise<CompanyMember[]> {
    return (await this.#store.transaction((session) => session.membersByName(null))).map(toCompanyMember);
  }

  async find(userIds: readonly string[]): Promise<CompanyMember[]> {
    const ids = [...new Set(userIds.filter((id) => isUuid(id)).map((id) => id.toLowerCase()))];
    if (ids.length === 0) {
      return [];
    }
    return (await this.#store.transaction((session) => session.membersByName(ids))).map(toCompanyMember);
  }
}

function toCompanyMember(member: StoredMember): CompanyMember {
  return { userId: member.userId, displayName: member.displayName, email: member.email, role: member.role };
}
