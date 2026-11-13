import type { INestApplication } from '@nestjs/common';
import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplicationCatalog } from '../src/catalog/application/application-catalog.ts';
import { Environments } from '../src/environments/application/environments.ts';
import { CompanyAccessService } from '../src/identity-access/application/company-access.service.ts';
import { USER_DIRECTORY, type UserDirectory } from '../src/identity-access/application/ports.ts';
import { toPrincipal } from '../src/identity-access/domain/access.ts';
import type { SampleIdentity } from '../src/sample-data/keycloak-admin.ts';
import { SAMPLE_ACCOUNTS } from '../src/sample-data/sample-accounts.ts';
import { seedSampleApplications } from '../src/sample-data/sample-applications.ts';
import { type SampleUsers, seedSampleCompany } from '../src/sample-data/sample-company.ts';
import { CompaniesService } from '../src/tenancy/application/companies.service.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';

let database: TestDatabase;
let app: INestApplication;

/** Keycloak's accounts in memory. The Platform Admin exists, as a new local realm has them. */
class FakeSampleUsers implements SampleUsers {
  readonly accounts = new Map<string, SampleIdentity & { password: string | null }>();
  readonly created: string[] = [];

  constructor(existing: readonly string[]) {
    for (const username of existing) {
      this.#add(username, null);
    }
  }

  async ensureUser(account: { username: string; password: string }): Promise<SampleIdentity> {
    const found = this.accounts.get(account.username);
    if (found !== undefined) {
      return { ...found, created: false };
    }
    this.created.push(account.username);
    return { ...this.#add(account.username, account.password), created: true };
  }

  async findUser(username: string): Promise<SampleIdentity | null> {
    return this.accounts.get(username) ?? null;
  }

  #add(username: string, password: string | null) {
    const identity = {
      username,
      subject: `kc-${username}`,
      email: `${username}@example.com`,
      emailVerified: true,
      displayName: username.replace('dev-', 'Dev '),
      created: false,
      password,
    };
    this.accounts.set(username, identity);
    return identity;
  }
}

const seed = (users: SampleUsers) =>
  seedSampleCompany({
    users,
    directory: app.get<UserDirectory>(USER_DIRECTORY, { strict: false }),
    companies: app.get(CompaniesService, { strict: false }),
    access: app.get(CompanyAccessService, { strict: false }),
    password: 'fake-dummy-sample-user-password',
  });

/** Each sample account's companies and roles, as it would see them after signing in. */
const rolesOf = async (users: FakeSampleUsers) => {
  const directory = app.get<UserDirectory>(USER_DIRECTORY, { strict: false });
  const roles: Record<string, string[]> = {};
  for (const account of SAMPLE_ACCOUNTS) {
    const identity = users.accounts.get(account.username)!;
    const userId = await directory.recordLogin({ ...identity, platformAdmin: false, idToken: null });
    const access = await directory.loadAccess(userId);
    roles[account.username] = access!.memberships.map((membership) => `${membership.companyName}: ${membership.role}`);
  }
  return roles;
};

beforeAll(async () => {
  database = await startTestDatabase();
  app = await buildApp({
    config: {
      databaseUrl: database.urlFor('app'),
      relayDatabaseUrl: database.urlFor('relay'),
      jobsDatabaseUrl: database.urlFor('jobs'),
    },
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await database?.stop();
});

describe('the sample company', () => {
  it('is created with one sample account in each role, adding the accounts an older realm lacks', async () => {
    const users = new FakeSampleUsers(['dev-platform-admin', 'dev-company-admin', 'dev-developer']);

    const result = await seed(users);

    expect(result).toMatchObject({ companyName: 'Dummy Company', companyCreated: true });
    expect(result.accounts.map((account) => [account.username, account.actualRole, account.accountCreated, account.joinedNow])).toEqual([
      ['dev-company-admin', 'company-admin', false, true],
      ['dev-tech-lead', 'tech-lead', true, true],
      ['dev-developer', 'developer', false, true],
      ['dev-operator', 'operator', true, true],
      ['dev-viewer', 'viewer', true, true],
    ]);
    expect(users.created).toEqual(['dev-tech-lead', 'dev-operator', 'dev-viewer']);
    expect(users.accounts.get('dev-viewer')!.password).toBe('fake-dummy-sample-user-password');
    expect(await rolesOf(users)).toEqual({
      'dev-company-admin': ['Dummy Company: company-admin'],
      'dev-tech-lead': ['Dummy Company: tech-lead'],
      'dev-developer': ['Dummy Company: developer'],
      'dev-operator': ['Dummy Company: operator'],
      'dev-viewer': ['Dummy Company: viewer'],
    });
    const companies = await app.get(CompaniesService, { strict: false }).list();
    expect(companies.filter((company) => company.name === 'Dummy Company')).toHaveLength(1);
  });

  it('is left as it is on the next start, keeping changes people made, and adds back who’s missing', async () => {
    const users = new FakeSampleUsers(SAMPLE_ACCOUNTS.map((account) => account.username).concat('dev-platform-admin'));
    const first = await seed(users);
    const directory = app.get<UserDirectory>(USER_DIRECTORY, { strict: false });
    const access = app.get(CompanyAccessService, { strict: false });
    const company = parseCompanyId(first.companyId);
    const admin = toPrincipal(
      (await directory.loadAccess(await directory.recordLogin({ ...users.accounts.get('dev-company-admin')!, platformAdmin: false, idToken: null })))!,
      first.companyId,
    );
    const userIdOf = async (username: string) =>
      directory.recordLogin({ ...users.accounts.get(username)!, platformAdmin: false, idToken: null });
    // The Company Admin made the viewer an operator, and removed the developer.
    await runWithCompany(company, async () => {
      await access.changeRole(admin, await userIdOf('dev-viewer'), 'operator');
      await access.removeMember(admin, await userIdOf('dev-developer'));
      // An earlier start stopped after inviting the developer again, before accepting.
      await access.invite(admin, 'dev-developer@example.com', 'developer');
    });

    const again = await seed(users);

    expect(again).toMatchObject({ companyId: first.companyId, companyCreated: false });
    expect(again.accounts.map((account) => [account.username, account.actualRole, account.joinedNow])).toEqual([
      ['dev-company-admin', 'company-admin', false],
      ['dev-tech-lead', 'tech-lead', false],
      ['dev-developer', 'developer', true],
      ['dev-operator', 'operator', false],
      ['dev-viewer', 'operator', false],
    ]);
    expect(await seed(users)).toMatchObject({ accounts: expect.arrayContaining([expect.objectContaining({ joinedNow: false })]) });
  });

  it('needs the sample Platform Admin, who creates it', async () => {
    await expect(seed(new FakeSampleUsers([]))).rejects.toThrow(
      "dev-platform-admin isn't in Keycloak. Reset the local services, as the README explains.",
    );
  });
});

describe('the sample applications', () => {
  const seedApplications = (companyId: string, members: readonly { username: string; userId: string }[]) =>
    seedSampleApplications(
      {
        directory: app.get<UserDirectory>(USER_DIRECTORY, { strict: false }),
        catalog: app.get(ApplicationCatalog, { strict: false }),
        environments: app.get(Environments, { strict: false }),
      },
      companyId,
      members,
    );
  const catalog = () => app.get(ApplicationCatalog, { strict: false });
  const environments = () => app.get(Environments, { strict: false });

  it('are registered by the sample Tech Lead, one for each type, language and framework, each with a Test environment', async () => {
    const company = await seed(new FakeSampleUsers(SAMPLE_ACCOUNTS.map((account) => account.username).concat('dev-platform-admin')));
    const techLead = company.accounts.find((account) => account.username === 'dev-tech-lead')!;

    const result = await seedApplications(company.companyId, [techLead]);

    expect(result.registeredBy).toBe('dev-tech-lead');
    expect(result.applications).toHaveLength(18);
    expect(result.applications.every((application) => application.created && application.environmentCreated)).toBe(true);
    await runWithCompany(parseCompanyId(company.companyId), async () => {
      const registered = await catalog().list('active');
      expect(registered.map((application) => `${application.name}: ${application.blueprint?.key}`)).toEqual(
        expect.arrayContaining(['Axum Rust API: axum-rust-service', 'PyScript Python Frontend: pyscript-frontend']),
      );
      const axum = registered.find((application) => application.name === 'Axum Rust API')!;
      expect(axum).toMatchObject({ type: { key: 'restful-service' }, slug: 'axum-rust-api' });
      expect(await environments().list(axum.id, 'active')).toEqual([
        expect.objectContaining({ name: 'Test', slug: 'test', production: false }),
      ]);
    });
  });

  it('are left as they are on the next start, archived ones included, and get back a missing Test environment', async () => {
    const company = await seed(new FakeSampleUsers(SAMPLE_ACCOUNTS.map((account) => account.username).concat('dev-platform-admin')));
    const techLead = company.accounts.find((account) => account.username === 'dev-tech-lead')!;
    const principal = toPrincipal(
      (await app.get<UserDirectory>(USER_DIRECTORY, { strict: false }).loadAccess(techLead.userId))!,
      company.companyId,
    );
    await seedApplications(company.companyId, [techLead]);
    // Someone archived the Flask API, and the Vue frontend's Test environment.
    await runWithCompany(parseCompanyId(company.companyId), async () => {
      const registered = await catalog().list('active');
      await catalog().archive(principal, registered.find((application) => application.name === 'Flask Python API')!.id);
      const vue = registered.find((application) => application.name === 'Vue TypeScript Frontend')!;
      const [test] = await environments().list(vue.id, 'active');
      await environments().archive(principal, test!.id, { version: test!.version });
      // And the React frontend's Test environment was renamed, so it has none by that name.
      const react = registered.find((application) => application.name === 'React TypeScript Frontend')!;
      const [reactTest] = await environments().list(react.id, 'active');
      await environments().update(principal, reactTest!.id, { name: 'QA', version: reactTest!.version });
    });

    const again = await seedApplications(company.companyId, [techLead]);

    expect(again.applications.filter((application) => application.created)).toEqual([]);
    expect(again.applications.filter((application) => application.environmentCreated).map((application) => application.name)).toEqual([
      'React TypeScript Frontend',
    ]);
    await runWithCompany(parseCompanyId(company.companyId), async () => {
      expect((await catalog().list('archived')).map((application) => application.name)).toEqual(['Flask Python API']);
    });
  });

  it('are left out when no sample member may register applications', async () => {
    const company = await seed(new FakeSampleUsers(SAMPLE_ACCOUNTS.map((account) => account.username).concat('dev-platform-admin')));
    const viewer = company.accounts.find((account) => account.username === 'dev-viewer')!;

    expect(await seedApplications(company.companyId, [viewer])).toEqual({ registeredBy: null, applications: [] });
  });
});
