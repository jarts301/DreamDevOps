import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requiresMfa, type UserAccess } from '../src/identity-access/domain/access.ts';
import { createTestApp, DASHBOARD_URL } from './test-app.ts';

const access = (overrides: Partial<UserAccess>): UserAccess => ({
  userId: 'u',
  subject: 's',
  email: 'e@example.com',
  emailVerified: true,
  displayName: 'E',
  platformPermissions: [],
  memberships: [],
  ...overrides,
});
const member = (role: string) => ({ companyId: 'c', companyName: 'C', role, permissions: [] });

describe('who needs a second factor', () => {
  it('is platform admins, Company Admins and Tech Leads', () => {
    expect(requiresMfa(access({ platformPermissions: ['companies:manage'] }))).toBe(true);
    expect(requiresMfa(access({ memberships: [member('company-admin')] }))).toBe(true);
    expect(requiresMfa(access({ memberships: [member('developer'), member('tech-lead')] }))).toBe(true);
  });

  it('is nobody else', () => {
    expect(requiresMfa(access({}))).toBe(false);
    expect(requiresMfa(access({ memberships: [member('developer'), member('operator'), member('viewer')] }))).toBe(false);
  });
});

describe('signing in', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({ config: { secureCookies: false } });
  });

  afterAll(async () => {
    await app.close();
  });

  /** Follows the login's redirects within the API and the fake provider, like a browser. */
  const signIn = async (user: string) => {
    const agent = request.agent(app.getHttpServer());
    const steps: string[] = [];
    let next = `/api/v1/auth/login?login_hint=${user}`;
    for (let step = 0; step < 6; step += 1) {
      const response = await agent.get(next);
      if (response.status !== 302) {
        return { agent, steps, final: response };
      }
      const location = new URL(response.headers.location as string, 'http://api.test');
      steps.push(location.pathname + location.search);
      if (!location.pathname.startsWith('/api/v1/auth/')) {
        return { agent, steps, final: response };
      }
      next = location.pathname + location.search;
    }
    throw new Error('Too many redirects.');
  };

  it('asks a Tech Lead who signed in without one for a second factor', async () => {
    const { agent, steps } = await signIn('nomfa-tech-lead');

    expect(steps).toContain('/api/v1/auth/login?mfa=1&login_hint=nomfa-tech-lead%40example.com');
    expect(steps.at(-1)).toBe(new URL(DASHBOARD_URL).pathname);
    await agent.get('/api/v1/auth/me').expect(200);
  });

  it("doesn't ask a developer", async () => {
    const { agent, steps } = await signIn('nomfa-developer');

    expect(steps.some((step) => step.includes('mfa=1'))).toBe(false);
    await agent.get('/api/v1/auth/me').expect(200);
  });

  it('refuses a Tech Lead when the login provider returns no second factor', async () => {
    const { agent, final } = await signIn('nomfa-refuse-tech-lead');

    expect(final.status).toBe(403);
    expect(final.body.detail).toBe('Your login provider did not confirm a second factor.');
    await agent.get('/api/v1/auth/me').expect(401);
  });
});
