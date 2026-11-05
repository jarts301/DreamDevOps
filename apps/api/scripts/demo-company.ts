// The demo company of the local stack, with one sample user in each company role.
import { createDomainEvent, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type { Pool } from 'pg';
import { CompanyRegistryService } from '../src/tenancy/application/company-registry.service.ts';
import { TenancyError } from '../src/tenancy/domain/errors.ts';

export interface SampleUser {
  readonly username: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
}

export interface DemoMember extends SampleUser {
  readonly role: string;
}

export const DEMO_COMPANY = { name: 'Demo Company', slug: 'demo-company' } as const;

/** Creates the demo company. It must be able to sign in already, so Keycloak knows it too. */
export const PLATFORM_ADMIN: SampleUser = {
  username: 'dev-platform-admin',
  email: 'dev-platform-admin@example.com',
  firstName: 'Dev',
  lastName: 'Platform Admin',
};

const member = (role: string, roleName: string): DemoMember => ({
  username: `demo-${role}`,
  email: `demo-${role}@example.com`,
  firstName: 'Demo',
  lastName: roleName,
  role,
});

/** One member per company role, named after it. The realm file lists them too. */
export const DEMO_MEMBERS: readonly DemoMember[] = [
  member('company-admin', 'Company Admin'),
  member('tech-lead', 'Tech Lead'),
  member('developer', 'Developer'),
  member('operator', 'Operator'),
  member('viewer', 'Viewer'),
];

export interface SeedResult {
  readonly created: boolean;
  readonly companyId: string;
}

/**
 * Creates the demo company the way a Platform Admin does, so its Git organization is
 * provisioned like any other, and adds its members. It does nothing if the company is
 * already there, so people can change it without this changing it back.
 *
 * Use a pool that signs in as dreamdevops_app, so this has only the API's own access.
 * Subjects are each user's ID in the login provider, by username.
 */
export async function seedDemoCompany(pool: Pool, subjects: ReadonlyMap<string, string>): Promise<SeedResult> {
  const registry = new CompanyRegistryService(new TenantDatabase(pool), pool);
  const existing = (await registry.list()).find((company) => company.slug === DEMO_COMPANY.slug);
  if (existing !== undefined) {
    return { created: false, companyId: existing.id };
  }

  const platformAdmin = await recordUser(pool, PLATFORM_ADMIN, subjects, true);
  let company: { id: string };
  try {
    company = await registry.create({ userId: platformAdmin }, DEMO_COMPANY.name, DEMO_COMPANY.slug);
  } catch (error) {
    // Another start of the API made it at the same moment.
    const made = (await registry.list()).find((candidate) => candidate.slug === DEMO_COMPANY.slug);
    if (error instanceof TenancyError && made !== undefined) {
      return { created: false, companyId: made.id };
    }
    throw error;
  }

  const database = new TenantDatabase(pool);
  await runWithCompany(parseCompanyId(company.id), () =>
    database.transaction(async (tx) => {
      for (const [index, demoMember] of DEMO_MEMBERS.entries()) {
        const userId = await recordUser(tx, demoMember, subjects, false);
        // One millisecond apart, so the team lists them in this order, from Company Admin to Viewer.
        await tx.query(
          `INSERT INTO identity.memberships (company_id, user_id, role_key, joined_at)
           VALUES ($1, $2, $3, now() + make_interval(secs => $4::double precision / 1000))`,
          [company.id, userId, demoMember.role, index],
        );
        await appendToOutbox(tx, [
          createDomainEvent({
            eventType: 'RoleGranted',
            companyId: parseCompanyId(company.id),
            payload: { userId, role: demoMember.role, grantedBy: platformAdmin },
          }),
        ]);
      }
    }),
  );
  return { created: true, companyId: company.id };
}

/** Creates the user as their first login would, so that login finds them. */
async function recordUser(
  queryable: Pick<Pool, 'query'>,
  user: SampleUser,
  subjects: ReadonlyMap<string, string>,
  platformAdmin: boolean,
): Promise<string> {
  const subject = subjects.get(user.username);
  if (subject === undefined) {
    throw new Error(`The login provider has no user "${user.username}".`);
  }
  const { rows } = await queryable.query<{ id: string }>(
    'SELECT identity.record_login($1, $2, true, $3, $4) AS id',
    [subject, user.email, `${user.firstName} ${user.lastName}`, platformAdmin],
  );
  return rows[0]!.id;
}
