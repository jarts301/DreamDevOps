import { Controller, Get, type INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENTITLEMENT_PROVIDER, type EntitlementProvider, type ProviderStatus } from '../src/editions/application/ports.ts';
import { RequireFeature } from '../src/editions/http/feature.guard.ts';
import { Authenticated } from '../src/http/access.decorators.ts';
import { IDENTITY_PROVIDER } from '../src/identity-access/application/ports.ts';
import { GIT_PROVIDER } from '../src/tenancy/application/ports.ts';
import { FakeGitProvider, FakeIdentityProvider } from './fakes.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';
import { type Agent, eventually as waitUntil, signIn as signInAs, unique } from './support/integration.ts';

/** Stands in for the private commercial code, which supplies its own provider. */
class FakeCommercialProvider implements EntitlementProvider {
  installed = true;
  failing = false;
  features: ReadonlySet<string> = new Set(['progressive-deployments', 'audit-export']);

  statusFailing = false;

  async status(): Promise<ProviderStatus> {
    if (this.statusFailing) {
      throw new Error('The license server is unavailable.');
    }
    return { name: 'Test license', commercialAvailable: this.installed, detail: 'Valid for testing' };
  }

  async commercialFeatures(): Promise<ReadonlySet<string>> {
    if (this.failing) {
      throw new Error('The license server is unavailable.');
    }
    return this.features;
  }
}

@Controller('sample')
class PaidFeatureController {
  @Authenticated()
  @RequireFeature('progressive-deployments')
  @Get('canary')
  canary(): object {
    return { ok: true };
  }
}

let database: TestDatabase;
let ownerPool: pg.Pool;
let app: INestApplication;
const provider = new FakeCommercialProvider();

const eventually = (assertion: () => Promise<void> | void) => waitUntil(assertion);

const signIn = (user: string) => signInAs(app, user);


const createCompany = async () => {
  const platformAdmin = await signIn('platform-admin');
  const adminName = unique('admin');
  const { body } = await platformAdmin
    .post('/api/v1/platform/companies')
    .send({ name: unique('Company'), firstAdminEmail: `${adminName}@example.com` })
    .expect(201);
  const admin = await signIn(adminName);
  await admin.post('/api/v1/invitations/accept').send({ token: body.invitation.token }).expect(200);
  return { platformAdmin, admin, companyId: body.company.id as string };
};

const addViewer = async (admin: Agent) => {
  const name = unique('viewer');
  const { body } = await admin
    .post('/api/v1/company/invitations')
    .send({ email: `${name}@example.com`, role: 'viewer' })
    .expect(201);
  const viewer = await signIn(name);
  await viewer.post('/api/v1/invitations/accept').send({ token: body.token }).expect(200);
  return viewer;
};

const enabledFeatures = async (agent: Agent) => {
  const { body } = await agent.get('/api/v1/company/entitlements').expect(200);
  return {
    edition: body.edition as string,
    enabled: (body.features as { key: string; enabled: boolean }[]).filter((f) => f.enabled).map((f) => f.key),
  };
};

const COMMUNITY_FEATURES = [
  'companies-and-roles',
  'audit-history',
  'notifications',
  'git-flow',
  'standard-deployments',
  'monitoring',
];

beforeAll(async () => {
  database = await startTestDatabase();
  ownerPool = new pg.Pool({ connectionString: database.urlFor('owner') });
  app = await buildApp({
    background: true,
    controllers: [PaidFeatureController],
    config: {
      databaseUrl: database.urlFor('app'),
      relayDatabaseUrl: database.urlFor('relay'),
      jobsDatabaseUrl: database.urlFor('jobs'),
      secureCookies: false,
    },
    overrides: [
      { provide: IDENTITY_PROVIDER, useValue: new FakeIdentityProvider() },
      { provide: GIT_PROVIDER, useValue: new FakeGitProvider() },
      { provide: ENTITLEMENT_PROVIDER, useValue: provider },
    ],
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await ownerPool?.end();
  await database?.stop();
});

beforeEach(() => {
  provider.installed = true;
  provider.failing = false;
  provider.statusFailing = false;
  provider.features = new Set(['progressive-deployments', 'audit-export']);
});

describe('a new company', () => {
  it('starts on the Community Edition, with every Community feature on', async () => {
    const { admin } = await createCompany();
    const viewer = await addViewer(admin);

    for (const member of [admin, viewer]) {
      await expect(enabledFeatures(member)).resolves.toEqual({ edition: 'community', enabled: COMMUNITY_FEATURES });
    }
    await admin.get('/api/v1/sample/canary').expect(403);
  });
});

describe('the Commercial Edition', () => {
  it('turns on only the commercial features the provider grants', async () => {
    const { platformAdmin, admin, companyId } = await createCompany();

    await platformAdmin.put(`/api/v1/platform/editions/${companyId}`).send({ edition: 'commercial' }).expect(204);

    await expect(enabledFeatures(admin)).resolves.toEqual({
      edition: 'commercial',
      enabled: [...COMMUNITY_FEATURES, 'progressive-deployments', 'audit-export'],
    });
    await admin.get('/api/v1/sample/canary').expect(200);
  });

  it('ignores grants of unknown or Community features, and never removes Community ones', async () => {
    const { platformAdmin, admin, companyId } = await createCompany();
    provider.features = new Set(['made-up', 'audit-export']);

    await platformAdmin.put(`/api/v1/platform/editions/${companyId}`).send({ edition: 'commercial' }).expect(204);

    await expect(enabledFeatures(admin)).resolves.toMatchObject({ enabled: [...COMMUNITY_FEATURES, 'audit-export'] });
  });

  it('keeps commercial features off when the provider fails', async () => {
    const { platformAdmin, admin, companyId } = await createCompany();
    await platformAdmin.put(`/api/v1/platform/editions/${companyId}`).send({ edition: 'commercial' }).expect(204);
    provider.failing = true;

    await expect(enabledFeatures(admin)).resolves.toEqual({ edition: 'commercial', enabled: COMMUNITY_FEATURES });
    await admin.get('/api/v1/sample/canary').expect(403);
  });

  it("can't be chosen when the commercial code isn't installed", async () => {
    const { platformAdmin, admin, companyId } = await createCompany();
    provider.installed = false;

    const { body } = await platformAdmin
      .put(`/api/v1/platform/editions/${companyId}`)
      .send({ edition: 'commercial' })
      .expect(409);

    expect(body.detail).toBe('The Commercial Edition is not installed on this server.');
    await expect(enabledFeatures(admin)).resolves.toMatchObject({ edition: 'community' });
  });

  it('applies to one company only', async () => {
    const first = await createCompany();
    const second = await createCompany();

    await first.platformAdmin.put(`/api/v1/platform/editions/${first.companyId}`).send({ edition: 'commercial' }).expect(204);

    await second.admin.get('/api/v1/sample/canary').expect(403);
    await expect(enabledFeatures(second.admin)).resolves.toMatchObject({ edition: 'community' });
  });
});

describe('setting a company’s edition', () => {
  it('is recorded in the audit log, with who did it', async () => {
    const { platformAdmin, admin, companyId } = await createCompany();

    await platformAdmin.put(`/api/v1/platform/editions/${companyId}`).send({ edition: 'commercial' }).expect(204);
    await platformAdmin.put(`/api/v1/platform/editions/${companyId}`).send({ edition: 'commercial' }).expect(204);
    await platformAdmin.put(`/api/v1/platform/editions/${companyId}`).send({ edition: 'community' }).expect(204);

    await eventually(async () => {
      const { body } = await admin.get('/api/v1/company/audit').expect(200);
      const changes = (body.entries as { eventType: string; actor: { displayName: string }; payload: object }[]).filter(
        (entry) => entry.eventType === 'CompanyEditionChanged',
      );
      // Setting the same edition again changes nothing, so it isn't recorded.
      expect(changes).toHaveLength(2);
      expect(changes.map((change) => change.payload)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ edition: 'commercial', previousEdition: 'community' }),
          expect.objectContaining({ edition: 'community', previousEdition: 'commercial' }),
        ]),
      );
      expect(changes[0]!.actor.displayName).toBe('platform-admin');
    });
  });

  it('lists every company with its edition and the provider’s status', async () => {
    const { platformAdmin, companyId } = await createCompany();
    await platformAdmin.put(`/api/v1/platform/editions/${companyId}`).send({ edition: 'commercial' }).expect(204);

    const { body } = await platformAdmin.get('/api/v1/platform/editions').expect(200);

    expect(body.provider).toEqual({ name: 'Test license', commercialAvailable: true, detail: 'Valid for testing' });
    expect(body.companies).toContainEqual(
      expect.objectContaining({ companyId, edition: 'commercial', changedAt: expect.any(String) }),
    );
  });

  it('shows the provider as unavailable when it fails, and refuses the Commercial Edition meanwhile', async () => {
    const { platformAdmin, companyId } = await createCompany();
    provider.statusFailing = true;

    const { body } = await platformAdmin.get('/api/v1/platform/editions').expect(200);

    expect(body.provider).toEqual({
      name: 'Unavailable',
      commercialAvailable: false,
      detail: 'The license could not be checked.',
    });
    await platformAdmin.put(`/api/v1/platform/editions/${companyId}`).send({ edition: 'commercial' }).expect(409);
  });

  it('changes nothing, and records nothing, when the company already has the edition', async () => {
    const { platformAdmin, companyId } = await createCompany();

    await platformAdmin.put(`/api/v1/platform/editions/${companyId}`).send({ edition: 'community' }).expect(204);

    const { rows } = await ownerPool.query('SELECT 1 FROM editions.company_editions WHERE company_id = $1', [companyId]);
    expect(rows).toEqual([]);
  });

  it('refuses bad input', async () => {
    const { platformAdmin, companyId } = await createCompany();

    await platformAdmin.put(`/api/v1/platform/editions/${companyId}`).send({ edition: 'gold' }).expect(400);
    await platformAdmin.put('/api/v1/platform/editions/not-an-id').send({ edition: 'community' }).expect(400);
    await platformAdmin
      .put('/api/v1/platform/editions/00000000-0000-4000-8000-000000000000')
      .send({ edition: 'community' })
      .expect(404);
  });

  it('is only for platform admins', async () => {
    const { admin, companyId } = await createCompany();

    await admin.get('/api/v1/platform/editions').expect(403);
    await admin.put(`/api/v1/platform/editions/${companyId}`).send({ edition: 'commercial' }).expect(403);
    const { rows } = await ownerPool.query('SELECT 1 FROM editions.company_editions WHERE company_id = $1', [companyId]);
    expect(rows).toHaveLength(0);
  });

  it('can’t be done by the app’s database role outside its granted columns', async () => {
    const appPool = new pg.Pool({ connectionString: database.urlFor('app') });
    try {
      await expect(appPool.query('DELETE FROM editions.company_editions')).rejects.toThrow(/permission denied/);
    } finally {
      await appPool.end();
    }
  });
});

describe('the entitlements of a user without a company', () => {
  it('are refused', async () => {
    const platformAdmin = await signIn('platform-admin');

    await platformAdmin.get('/api/v1/company/entitlements').expect(403);
  });
});
