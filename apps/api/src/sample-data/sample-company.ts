import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { CompanyAccessService } from '../identity-access/application/company-access.service.ts';
import type { UserDirectory } from '../identity-access/application/ports.ts';
import { type Principal, toPrincipal } from '../identity-access/domain/access.ts';
import type { CompaniesService } from '../tenancy/application/companies.service.ts';
import type { SampleIdentity } from './keycloak-admin.ts';
import { SAMPLE_ACCOUNTS, SAMPLE_COMPANY_NAME, SAMPLE_PLATFORM_ADMIN, type SampleAccount, sampleEmail } from './sample-accounts.ts';

/** Where sample accounts come from: the login provider. */
export interface SampleUsers {
  ensureUser(account: {
    readonly username: string;
    readonly email: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly password: string;
  }): Promise<SampleIdentity>;
  findUser(username: string): Promise<SampleIdentity | null>;
}

export interface SampleCompanyDependencies {
  readonly users: SampleUsers;
  readonly directory: UserDirectory;
  readonly companies: CompaniesService;
  readonly access: CompanyAccessService;
  /** The password new sample accounts get. */
  readonly password: string;
}

export interface SampleCompanyResult {
  readonly companyId: string;
  readonly companyName: string;
  /** Whether the company was created now, rather than found. */
  readonly companyCreated: boolean;
  readonly accounts: readonly {
    readonly username: string;
    readonly role: string;
    /** The account's role in the company, which may differ if someone changed it. */
    readonly actualRole: string;
    readonly accountCreated: boolean;
    readonly joinedNow: boolean;
  }[];
}

/**
 * Makes sure the sample company exists, with one sample account in each role. It goes
 * through the same steps people do: the Platform Admin creates the company, its admin
 * accepts, and invites everyone else, who accept. So the company's Git organization,
 * teams and audit log are set up as for any company. No email is sent.
 *
 * Safe to run on every start. Nothing that exists is changed: a role someone changed
 * stays changed, and a removed member isn't added back until the next run.
 */
export async function seedSampleCompany(dependencies: SampleCompanyDependencies): Promise<SampleCompanyResult> {
  const { users, directory, companies, access, password } = dependencies;
  const platformAdminIdentity = await users.findUser(SAMPLE_PLATFORM_ADMIN);
  if (platformAdminIdentity === null) {
    throw new Error(`${SAMPLE_PLATFORM_ADMIN} isn't in Keycloak. Reset the local services, as the README explains.`);
  }
  const platformAdmin = await principalOf(directory, platformAdminIdentity, { platformAdmin: true }, null);
  if (!platformAdmin.permissions.includes('companies:manage')) {
    throw new Error(`${SAMPLE_PLATFORM_ADMIN} isn't a Platform Admin in Keycloak.`);
  }

  const people = new Map<string, { account: SampleAccount; identity: SampleIdentity; userId: string }>();
  for (const account of SAMPLE_ACCOUNTS) {
    const identity = await users.ensureUser({
      username: account.username,
      email: sampleEmail(account.username),
      firstName: account.firstName,
      lastName: account.lastName,
      password,
    });
    const userId = await directory.recordLogin({ ...identity, platformAdmin: false, idToken: null });
    people.set(account.username, { account, identity, userId });
  }

  const existing = (await companies.list()).find((company) => company.name.toLowerCase() === SAMPLE_COMPANY_NAME.toLowerCase());
  let companyId = existing?.id;
  let firstAdminToken: string | null = null;
  if (companyId === undefined) {
    const firstAdmin = people.get(SAMPLE_ACCOUNTS[0]!.username)!;
    const created = await companies.create(platformAdmin, SAMPLE_COMPANY_NAME, firstAdmin.identity.email);
    companyId = created.company.id;
    firstAdminToken = created.invitation.token;
  }
  const company = parseCompanyId(companyId);

  const results: SampleCompanyResult['accounts'][number][] = [];
  for (const account of SAMPLE_ACCOUNTS) {
    const person = people.get(account.username)!;
    const before = await directory.loadAccess(person.userId);
    const membership = before?.memberships.find((candidate) => candidate.companyId === companyId);
    if (membership !== undefined) {
      results.push({ ...summary(person), actualRole: membership.role, joinedNow: false });
      continue;
    }
    let token = account.role === 'company-admin' ? firstAdminToken : null;
    if (token === null) {
      // The company's admin invites the others, as they would. Until it has one, the Platform Admin does.
      const inviter = await inviterFor(directory, people, company, platformAdmin);
      // Invitations go to the email the account signs in with, which is what accepting checks.
      token = await runWithCompany(company, () => invite(access, inviter, person.identity.email, account.role));
    }
    const principal = await principalOf(directory, person.identity, { platformAdmin: false }, companyId);
    await access.acceptInvitation(principal, token);
    results.push({ ...summary(person), actualRole: account.role, joinedNow: true });
  }

  return { companyId, companyName: existing?.name ?? SAMPLE_COMPANY_NAME, companyCreated: existing === undefined, accounts: results };
}

function summary(person: { account: SampleAccount; identity: SampleIdentity }) {
  return { username: person.account.username, role: person.account.role, accountCreated: person.identity.created };
}

/** The sample Company Admin, if they're a member already, or else the Platform Admin. */
async function inviterFor(
  directory: UserDirectory,
  people: ReadonlyMap<string, { identity: SampleIdentity; userId: string }>,
  companyId: string,
  platformAdmin: Principal,
): Promise<Principal> {
  const companyAdmin = people.get(SAMPLE_ACCOUNTS[0]!.username)!;
  const access = await directory.loadAccess(companyAdmin.userId);
  return access?.memberships.some((membership) => membership.companyId === companyId)
    ? toPrincipal(access, companyId)
    : platformAdmin;
}

/**
 * Invites someone, replacing an open invitation an earlier run left behind, whose token
 * nobody has any more.
 */
async function invite(access: CompanyAccessService, actor: Principal, email: string, role: string): Promise<string> {
  const open = (await access.listInvitations()) as { id: string; email: string }[];
  for (const invitation of open.filter((candidate) => candidate.email === email)) {
    await access.revokeInvitation(actor, invitation.id);
  }
  return (await access.invite(actor, email, role)).token;
}

async function principalOf(
  directory: UserDirectory,
  identity: SampleIdentity,
  options: { readonly platformAdmin: boolean },
  companyId: string | null,
): Promise<Principal> {
  const userId = await directory.recordLogin({ ...identity, platformAdmin: options.platformAdmin, idToken: null });
  const access = await directory.loadAccess(userId);
  if (access === null) {
    throw new Error(`${identity.username} couldn't be loaded.`);
  }
  return toPrincipal(access, companyId);
}
