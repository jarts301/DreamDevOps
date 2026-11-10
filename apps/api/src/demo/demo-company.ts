import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { CompanyAccessService } from '../identity-access/application/company-access.service.ts';
import type { UserDirectory } from '../identity-access/application/ports.ts';
import { type Principal, toPrincipal } from '../identity-access/domain/access.ts';
import type { CompaniesService } from '../tenancy/application/companies.service.ts';

export const DEMO_COMPANY_NAME = 'Demo Company';

export interface DemoUser {
  readonly username: string;
  /** The Keycloak user ID, fixed by infra/local/ops/keycloak-init.sh. */
  readonly subject: string;
  readonly displayName: string;
  /** The role in the demo company, or null for the platform admin, who belongs to none. */
  readonly role: string | null;
}

/** One user for each role. Keep in step with infra/local/ops/keycloak-init.sh. */
export const DEMO_USERS: readonly DemoUser[] = [
  { username: 'demo-platform-admin', subject: 'd3d00000-0000-4000-8000-000000000001', displayName: 'Demo Platform Admin', role: null },
  { username: 'demo-company-admin', subject: 'd3d00000-0000-4000-8000-000000000002', displayName: 'Demo Company Admin', role: 'company-admin' },
  { username: 'demo-tech-lead', subject: 'd3d00000-0000-4000-8000-000000000003', displayName: 'Demo Tech Lead', role: 'tech-lead' },
  { username: 'demo-developer', subject: 'd3d00000-0000-4000-8000-000000000004', displayName: 'Demo Developer', role: 'developer' },
  { username: 'demo-operator', subject: 'd3d00000-0000-4000-8000-000000000005', displayName: 'Demo Operator', role: 'operator' },
  { username: 'demo-viewer', subject: 'd3d00000-0000-4000-8000-000000000006', displayName: 'Demo Viewer', role: 'viewer' },
];

const emailOf = (user: DemoUser) => `${user.username}@example.com`;

/**
 * Sets up the demo company for local use: the platform admin creates it, and each demo
 * user joins with their role by accepting an invitation, through the same services
 * people use. So the audit log, Git organization and teams are made as usual. Whatever
 * is already there is kept, so it runs safely at every start. Only the local start
 * script turns it on, and it can't be on in production.
 */
export class DemoCompany implements OnApplicationBootstrap {
  readonly #logger = new Logger(DemoCompany.name);
  readonly #directory: UserDirectory;
  readonly #companies: CompaniesService;
  readonly #access: CompanyAccessService;

  constructor(directory: UserDirectory, companies: CompaniesService, access: CompanyAccessService) {
    this.#directory = directory;
    this.#companies = companies;
    this.#access = access;
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.setUp();
    } catch (error) {
      this.#logger.error(`Setting up the demo company failed: ${String(error)}`);
    }
  }

  async setUp(): Promise<void> {
    const userIds = new Map<string, string>();
    for (const user of DEMO_USERS) {
      userIds.set(
        user.username,
        await this.#directory.recordLogin({
          subject: user.subject,
          email: emailOf(user),
          emailVerified: true,
          displayName: user.displayName,
          platformAdmin: user.role === null,
          idToken: null,
          mfa: false,
        }),
      );
    }
    const principal = async (username: string, companyId: string | null = null): Promise<Principal> => {
      const access = await this.#directory.loadAccess(userIds.get(username)!);
      return toPrincipal(access!, companyId);
    };
    const isMember = async (username: string, companyId: string) =>
      (await principal(username)).memberships.some((membership) => membership.companyId === companyId);

    const platformAdmin = await principal('demo-platform-admin');
    const admin = DEMO_USERS.find((user) => user.role === 'company-admin')!;
    let companyId = (await this.#companies.list()).find((company) => company.name === DEMO_COMPANY_NAME)?.id;
    if (companyId === undefined) {
      const { company, invitation } = await this.#companies.create(platformAdmin, DEMO_COMPANY_NAME, emailOf(admin));
      companyId = company.id;
      await this.#access.acceptInvitation(await principal(admin.username), invitation.token);
      this.#logger.log(`Created the demo company, with ${admin.username} as its admin.`);
    } else if (!(await isMember(admin.username, companyId))) {
      const { invitation } = await this.#companies.inviteFirstAdmin(platformAdmin, companyId, emailOf(admin));
      await this.#access.acceptInvitation(await principal(admin.username), invitation.token);
    }

    const companyAdmin = await principal(admin.username, companyId);
    for (const user of DEMO_USERS) {
      if (user.role === null || user === admin || (await isMember(user.username, companyId))) {
        continue;
      }
      const invitation = await runWithCompany(parseCompanyId(companyId), () =>
        this.#access.invite(companyAdmin, emailOf(user), user.role),
      );
      await this.#access.acceptInvitation(await principal(user.username), invitation.token);
      this.#logger.log(`${user.username} joined the demo company.`);
    }
  }
}
