import { Controller, Get, type INestApplication } from '@nestjs/common';
import { createDomainEvent, parseCompanyId } from '@dreamdevops/shared-kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Entitlements } from '../src/editions/application/entitlements.ts';
import { FEATURES, parseEdition, resolveFeatures } from '../src/editions/domain/features.ts';
import { RequireFeature } from '../src/editions/http/feature.guard.ts';
import { CommunityEntitlementProvider } from '../src/editions/infrastructure/community-entitlement-provider.ts';
import { Authenticated, RequirePermissions } from '../src/http/access.decorators.ts';
import { summarize } from '../src/notifications/domain/event-catalog.ts';
import { COMPANY_A, COMPANY_B } from './fakes.ts';
import { createTestApp } from './test-app.ts';
import { signIn as signInAs } from './support/integration.ts';

const COMMUNITY = FEATURES.filter((feature) => feature.edition === 'community').map((feature) => feature.key);

describe('the feature catalog', () => {
  it('has unique keys, and features in both editions', () => {
    const keys = FEATURES.map((feature) => feature.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(COMMUNITY.length).toBeGreaterThan(0);
    expect(FEATURES.some((feature) => feature.edition === 'commercial')).toBe(true);
  });

  it('accepts only the two editions', () => {
    expect(parseEdition('community')).toBe('community');
    expect(parseEdition('commercial')).toBe('commercial');
    for (const value of ['Community', 'gold', '', null, 1]) {
      expect(() => parseEdition(value)).toThrow('Choose the Community or Commercial edition.');
    }
  });

  it('refuses a route that names an unknown feature', () => {
    expect(() => RequireFeature('made-up')).toThrow('Unknown feature "made-up"');
  });
});

describe('resolveFeatures', () => {
  it('turns on every Community feature, whatever the provider says', () => {
    expect([...resolveFeatures('community', new Set())]).toEqual(COMMUNITY);
    expect([...resolveFeatures('commercial', new Set())]).toEqual(COMMUNITY);
  });

  it('adds commercial features only for the Commercial Edition', () => {
    const granted = new Set(['audit-export', 'enterprise-sso']);
    expect(resolveFeatures('community', granted).has('audit-export')).toBe(false);
    expect([...resolveFeatures('commercial', granted)]).toEqual([...COMMUNITY, 'audit-export', 'enterprise-sso']);
  });

  it('ignores keys that are not commercial features', () => {
    expect([...resolveFeatures('commercial', new Set(['made-up', 'monitoring']))]).toEqual(COMMUNITY);
  });
});

describe('the Community provider', () => {
  it('has no commercial features to offer', async () => {
    const provider = new CommunityEntitlementProvider();
    await expect(provider.status()).resolves.toEqual({ name: 'Community', commercialAvailable: false, detail: null });
    await expect(provider.commercialFeatures()).resolves.toEqual(new Set());
  });
});

describe('edition change notifications', () => {
  it('say which edition the company moved to', () => {
    const event = createDomainEvent({
      eventType: 'CompanyEditionChanged',
      companyId: parseCompanyId(COMPANY_A),
      payload: { edition: 'commercial', previousEdition: 'community' },
    });
    expect(summarize(event, 'Acme')).toBe('Acme: The company moved to the Commercial Edition.');
  });
});

@Controller('sample')
class SampleController {
  @Authenticated()
  @RequireFeature('audit-export')
  @Get('export')
  export(): object {
    return { ok: true };
  }

  @RequirePermissions('applications:write')
  @RequireFeature('audit-export')
  @Get('export-write')
  exportWrite(): object {
    return { ok: true };
  }
}

describe('routes that need a feature', () => {
  let app: INestApplication;
  const checked: string[] = [];

  beforeAll(async () => {
    const entitlements = {
      isEnabled: async (companyId: string, feature: string) => {
        checked.push(`${companyId}:${feature}`);
        return companyId === COMPANY_A;
      },
    };
    app = await createTestApp({
      controllers: [SampleController],
      config: { secureCookies: false },
      overrides: [{ provide: Entitlements, useValue: entitlements }],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const signIn = (user: string) => signInAs(app, user);

  it('allow companies that have it', async () => {
    await (await signIn('developer-a')).get('/api/v1/sample/export').expect(200);
  });

  it('refuse companies that lack it, saying why', async () => {
    const { body } = await (await signIn('tech-lead-b')).get('/api/v1/sample/export').expect(403);
    expect(body.detail).toBe("Your company's edition doesn't include this feature.");
    expect(checked).toContain(`${COMPANY_B}:audit-export`);
  });

  it('refuse users without a company', async () => {
    await (await signIn('platform-admin')).get('/api/v1/sample/export').expect(403);
  });

  it('check permissions first, without asking about the feature', async () => {
    checked.length = 0;
    await (await signIn('developer-a')).get('/api/v1/sample/export-write').expect(403);
    await request(app.getHttpServer()).get('/api/v1/sample/export').expect(401);
    expect(checked).toEqual([]);
  });
});
