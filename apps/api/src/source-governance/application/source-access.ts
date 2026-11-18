import { MemberRemoved, RoleGranted } from '@dreamdevops/contracts/identity-access/events';
import { RepositoryCreated } from '@dreamdevops/contracts/source-governance/events';
import { CompanyProvisioned, CompanyReactivated, CompanySuspended } from '@dreamdevops/contracts/tenancy/events';
import { currentCompanyId, type EventContract } from '@dreamdevops/shared-kernel';
import type { Principal } from '@dreamdevops/contracts/identity-access/access';
import type { CompanyDirectory } from '@dreamdevops/contracts/tenancy/services';
import { planTeamChanges, TEAMS, teamFor, type TeamKey } from '../domain/git-flow.ts';
import type { SourceAccessView } from '@dreamdevops/contracts/source-governance/http';
import type { SourceHost, SourceStore } from './ports.ts';

/** The events that change who should be in which team. */
export const ACCESS_TRIGGERS: readonly EventContract[] = [
  RoleGranted,
  MemberRemoved,
  CompanySuspended,
  CompanyReactivated,
  CompanyProvisioned,
  RepositoryCreated,
];

/**
 * Keeps each organization's teams in line with the company's members and roles. People
 * get a Git account the first time they sign in to Forgejo, so they join their team at
 * the next sync after that. Removals and role changes apply at once, through events.
 */
export class SourceAccess {
  readonly #store: SourceStore;
  readonly #companies: CompanyDirectory;
  readonly #host: SourceHost;
  readonly #publicUrl: string;

  constructor(store: SourceStore, companies: CompanyDirectory, host: SourceHost, publicUrl: string) {
    this.#store = store;
    this.#companies = companies;
    this.#host = host;
    this.#publicUrl = publicUrl.replace(/\/$/, '');
  }

  /** Brings the current company's teams in line. Safe to repeat. */
  async syncCompany(): Promise<void> {
    const company = await this.#companies.find(currentCompanyId());
    const members = await this.#store.transaction((session) => session.memberAccounts());
    // Until the organization exists there's nothing to sync. A suspended company keeps
    // its organization, and has no members here, so everyone is removed.
    if (company === null || (company.status !== 'active' && company.status !== 'suspended')) {
      return;
    }

    const desired = new Map<string, TeamKey>();
    for (const member of members) {
      if (await this.#host.userExists(member.username)) {
        desired.set(member.username.toLowerCase(), teamFor(member.permissions));
      }
    }
    await this.#host.ensureTeams(company.slug);
    const current = new Map<TeamKey, string[]>();
    for (const { key } of TEAMS) {
      current.set(key, await this.#host.teamMembers(company.slug, key));
    }

    const { add, remove } = planTeamChanges(desired, current);
    // Removals first, so nobody briefly holds two teams' access.
    for (const change of remove) {
      await this.#host.removeTeamMember(company.slug, change.team, change.username);
    }
    for (const change of add) {
      await this.#host.addTeamMember(company.slug, change.team, change.username);
    }
  }

  /** The signed-in member's Git access in the current company. */
  async mine(principal: Principal): Promise<SourceAccessView> {
    const [account] = await this.#store.transaction((session) => session.memberAccounts(principal.userId));
    return {
      signInUrl: `${this.#publicUrl}/user/oauth2/keycloak`,
      gitUrl: this.#publicUrl,
      hasAccount: account === undefined ? false : await this.#host.userExists(account.username),
      team: teamFor(principal.permissions),
    };
  }
}
