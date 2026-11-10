import { Body, Controller, Get, type INestApplication, Post } from '@nestjs/common';
import { currentCompanyId } from '@dreamdevops/shared-kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Authenticated, Public, RequirePermissions } from '../src/http/access.decorators.ts';
import { COMPANY_A, COMPANY_B } from './fakes.ts';
import { createTestApp, DASHBOARD_URL } from './test-app.ts';
import { signIn } from './support/integration.ts';

@Controller('sample')
class SampleController {
  @Public()
  @Get('public')
  open(): object {
    return { ok: true };
  }

  @Get('undeclared')
  undeclared(): object {
    return { secret: true };
  }

  @Authenticated()
  @Get('signed-in')
  signedIn(): object {
    return { ok: true };
  }

  @RequirePermissions('applications:write')
  @Get('needs-write')
  needsWrite(): object {
    return { ok: true };
  }

  @RequirePermissions('applications:read', 'applications:write')
  @Get('needs-both')
  needsBoth(): object {
    return { ok: true };
  }

  @Authenticated()
  @Get('company')
  async company(): Promise<object> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { companyId: currentCompanyId() };
  }

  @Authenticated()
  @Post('echo')
  echo(@Body() body: object): object {
    return body;
  }

  @Public()
  @Get('crash')
  crash(): object {
    throw new Error('Connection to db.internal:5432 failed for user admin');
  }
}



describe('API', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // The test client only sends Secure cookies over HTTPS, so this app turns the flag off.
    app = await createTestApp({ controllers: [SampleController], config: { secureCookies: false } });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('login', () => {
    it('sends the browser to the login provider, then to the dashboard', async () => {
      const agent = request.agent(app.getHttpServer());

      const login = await agent.get('/api/v1/auth/login?login_hint=developer-a').expect(302);
      const callback = new URL(login.headers.location as string);
      const finished = await agent.get(callback.pathname + callback.search).expect(302);

      expect(callback.pathname).toBe('/api/v1/auth/callback');
      expect(finished.headers.location).toBe(DASHBOARD_URL);
    });

    it('returns who is signed in', async () => {
      const agent = await signIn(app, 'developer-a');

      const { body } = await agent.get('/api/v1/auth/me').expect(200);

      expect(body).toMatchObject({
        email: 'developer-a@example.com',
        displayName: 'developer-a',
        companyId: COMPANY_A,
        role: 'developer',
        permissions: ['applications:read'],
        memberships: [{ companyId: COMPANY_A, role: 'developer' }],
      });
    });

    it('gives the browser a cookie that scripts and other sites cannot use', async () => {
      const secureApp = await createTestApp({ config: { secureCookies: true } });
      try {
        const server = secureApp.getHttpServer();
        const login = await request(server).get('/api/v1/auth/login?login_hint=developer-a');
        const callback = new URL(login.headers.location as string);
        const loginCookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

        const finished = await request(server).get(callback.pathname + callback.search).set('Cookie', loginCookie);

        const cookies = finished.headers['set-cookie'] as unknown as string[];
        const session = cookies.find((cookie) => cookie.startsWith('dd_session='));
        expect(session).toMatch(/HttpOnly/i);
        expect(session).toMatch(/Secure/i);
        expect(session).toMatch(/SameSite=Lax/i);
      } finally {
        await secureApp.close();
      }
    });

    it('rejects a callback with the wrong state', async () => {
      const agent = request.agent(app.getHttpServer());
      await agent.get('/api/v1/auth/login?login_hint=developer-a');

      await agent.get('/api/v1/auth/callback?code=developer-a&state=forged').expect(400);
      await agent.get('/api/v1/auth/me').expect(401);
    });

    it('rejects a callback that no login started', async () => {
      await request(app.getHttpServer()).get('/api/v1/auth/callback?code=developer-a&state=anything').expect(400);
    });

    it('does not accept a login attempt twice', async () => {
      const agent = request.agent(app.getHttpServer());
      const login = await agent.get('/api/v1/auth/login?login_hint=developer-a');
      const callback = new URL(login.headers.location as string);
      await agent.get(callback.pathname + callback.search).expect(302);

      await agent.get(callback.pathname + callback.search).expect(400);
    });

    it.each(['unknown-user', 'constructor'])('does not treat %s as a user', async (name) => {
      const agent = request.agent(app.getHttpServer());
      const login = await agent.get(`/api/v1/auth/login?login_hint=${name}`);
      const callback = new URL(login.headers.location as string);

      await agent.get(callback.pathname + callback.search).expect(401);
    });

    it('issues a new session ID at each login and ends the old one', async () => {
      const server = app.getHttpServer();
      const sessionCookieOf = (response: request.Response) =>
        (response.headers['set-cookie'] as unknown as string[])
          .find((cookie) => cookie.startsWith('dd_session='))!
          .split(';')[0]!;
      const logIn = async (existingCookie?: string) => {
        const login = await request(server).get('/api/v1/auth/login?login_hint=developer-a');
        const loginCookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
        const callback = new URL(login.headers.location as string);
        return request(server)
          .get(callback.pathname + callback.search)
          .set('Cookie', [loginCookie, ...(existingCookie ? [existingCookie] : [])].join('; '));
      };

      const first = sessionCookieOf(await logIn());
      const second = sessionCookieOf(await logIn(first));

      expect(second).not.toBe(first);
      await request(server).get('/api/v1/auth/me').set('Cookie', first).expect(401);
      await request(server).get('/api/v1/auth/me').set('Cookie', second).expect(200);
    });

    it('ends the session at logout, on the server too', async () => {
      const agent = await signIn(app, 'developer-a');
      const me = await agent.get('/api/v1/auth/me').expect(200);
      expect(me.body.email).toBe('developer-a@example.com');

      await agent.post('/api/v1/auth/logout').expect(200);

      await agent.get('/api/v1/auth/me').expect(401);
    });
  });

  describe('choosing a company', () => {
    it('switches between companies the user belongs to', async () => {
      const agent = await signIn(app, 'consultant');
      await expect(agent.get('/api/v1/sample/company')).resolves.toMatchObject({ body: { companyId: COMPANY_A } });

      await agent.post('/api/v1/auth/active-company').send({ companyId: COMPANY_B }).expect(204);

      await expect(agent.get('/api/v1/sample/company')).resolves.toMatchObject({ body: { companyId: COMPANY_B } });
      await agent.get('/api/v1/sample/needs-write').expect(200);
    });

    it('refuses a company the user does not belong to', async () => {
      const agent = await signIn(app, 'developer-a');

      await agent.post('/api/v1/auth/active-company').send({ companyId: COMPANY_B }).expect(403);

      await expect(agent.get('/api/v1/sample/company')).resolves.toMatchObject({ body: { companyId: COMPANY_A } });
    });
  });

  describe('sessions', () => {
    it('rejects a made-up session ID', async () => {
      await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', 'dd_session=made-up').expect(401);
    });
  });

  describe('authorization', () => {
    it('lets anyone call a public route', async () => {
      await request(app.getHttpServer()).get('/api/v1/sample/public').expect(200);
    });

    it('asks anonymous users to sign in', async () => {
      await request(app.getHttpServer()).get('/api/v1/sample/signed-in').expect(401);
    });

    it('allows any signed-in user on an authenticated route', async () => {
      const agent = await signIn(app, 'developer-a');
      await agent.get('/api/v1/sample/signed-in').expect(200);
    });

    it('denies a route with no access rule, even for a signed-in user', async () => {
      const agent = await signIn(app, 'tech-lead-a');
      const response = await agent.get('/api/v1/sample/undeclared').expect(403);
      expect(response.body.secret).toBeUndefined();
    });

    it('denies a route with no access rule for anonymous users', async () => {
      await request(app.getHttpServer()).get('/api/v1/sample/undeclared').expect(401);
    });

    it('denies a user without the permission', async () => {
      const agent = await signIn(app, 'developer-a');
      await agent.get('/api/v1/sample/needs-write').expect(403);
    });

    it('allows a user with the permission', async () => {
      const agent = await signIn(app, 'tech-lead-a');
      await agent.get('/api/v1/sample/needs-write').expect(200);
    });

    it('requires every listed permission', async () => {
      const developer = await signIn(app, 'developer-a');
      const techLead = await signIn(app, 'tech-lead-a');

      await developer.get('/api/v1/sample/needs-both').expect(403);
      await techLead.get('/api/v1/sample/needs-both').expect(200);
    });
  });

  describe('company context', () => {
    it("uses the signed-in user's company", async () => {
      const agent = await signIn(app, 'tech-lead-b');
      const { body } = await agent.get('/api/v1/sample/company').expect(200);
      expect(body.companyId).toBe(COMPANY_B);
    });

    it('ignores any company the client tries to send', async () => {
      const agent = await signIn(app, 'tech-lead-a');

      const { body } = await agent
        .get(`/api/v1/sample/company?companyId=${COMPANY_B}`)
        .set('X-Company-Id', COMPANY_B)
        .expect(200);

      expect(body.companyId).toBe(COMPANY_A);
    });

    it('keeps concurrent requests from different companies apart', async () => {
      const agentA = await signIn(app, 'tech-lead-a');
      const agentB = await signIn(app, 'tech-lead-b');

      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          (index % 2 === 0 ? agentA : agentB).get('/api/v1/sample/company').expect(200),
        ),
      );

      responses.forEach((response, index) => {
        expect(response.body.companyId).toBe(index % 2 === 0 ? COMPANY_A : COMPANY_B);
      });
    });

    it('denies a company route to a user with no company', async () => {
      const agent = await signIn(app, 'platform-admin');
      await agent.get('/api/v1/sample/company').expect(403);
    });
  });

  describe('cross-site protection', () => {
    it('blocks a state-changing request from another site', async () => {
      const agent = await signIn(app, 'developer-a');

      await agent.post('/api/v1/sample/echo').set('Origin', 'http://evil.test').send({ a: 1 }).expect(403);
    });

    it('blocks logout from another site', async () => {
      const agent = await signIn(app, 'developer-a');

      await agent.post('/api/v1/auth/logout').set('Origin', 'http://evil.test').expect(403);

      await agent.get('/api/v1/auth/me').expect(200);
    });

    it('allows the dashboard and the API origins', async () => {
      const agent = await signIn(app, 'developer-a');

      await agent.post('/api/v1/sample/echo').set('Origin', 'http://dashboard.test').send({ a: 1 }).expect(201);
      await agent.post('/api/v1/sample/echo').set('Origin', 'http://api.test').send({ a: 1 }).expect(201);
    });

    it('does not allow other sites to read responses', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/sample/public')
        .set('Origin', 'http://evil.test');

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('errors', () => {
    it('hides internal details', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/sample/crash').expect(500);

      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.text).not.toContain('db.internal');
      expect(response.text).not.toContain('stack');
      expect(response.body.status).toBe(500);
    });

    it('answers unknown routes in the same format', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/nothing-here');

      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
    });

    it('rejects an oversized body', async () => {
      const agent = await signIn(app, 'developer-a');

      const response = await agent.post('/api/v1/sample/echo').send({ data: 'x'.repeat(1_100_000) });

      expect(response.status).toBe(413);
      expect(response.headers['content-type']).toContain('application/problem+json');
    });

    it('rejects malformed JSON', async () => {
      const agent = await signIn(app, 'developer-a');

      const response = await agent.post('/api/v1/sample/echo').set('Content-Type', 'application/json').send('{not json');

      expect(response.status).toBe(400);
      expect(response.text).not.toContain('SyntaxError');
    });
  });

  describe('security headers and health', () => {
    it('sets security headers and hides the framework', async () => {
      const { headers } = await request(app.getHttpServer()).get('/api/v1/sample/public');

      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['strict-transport-security']).toBeDefined();
      expect(headers['content-security-policy']).toBeDefined();
      expect(headers['x-powered-by']).toBeUndefined();
    });

    it('reports health without signing in', async () => {
      await request(app.getHttpServer()).get('/api/v1/health/live').expect(200, { status: 'up' });
      await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200, { status: 'up' });
    });
  });
});

describe('rate limits', () => {
  it('limits requests per client', async () => {
    const app = await createTestApp({ controllers: [SampleController], config: { rateLimitPerMinute: 3 } });
    try {
      const server = app.getHttpServer();
      for (let index = 0; index < 3; index += 1) {
        await request(server).get('/api/v1/sample/public').expect(200);
      }

      const limited = await request(server).get('/api/v1/sample/public').expect(429);

      expect(limited.headers['content-type']).toContain('application/problem+json');
    } finally {
      await app.close();
    }
  });

  it('limits login routes more strictly', async () => {
    const app = await createTestApp({
      controllers: [SampleController],
      config: { rateLimitPerMinute: 100, authRateLimitPerMinute: 2 },
    });
    try {
      const server = app.getHttpServer();
      await request(server).get('/api/v1/auth/login').expect(302);
      await request(server).get('/api/v1/auth/login').expect(302);

      await request(server).get('/api/v1/auth/login').expect(429);
      await request(server).get('/api/v1/sample/public').expect(200);
    } finally {
      await app.close();
    }
  });

  it('applies only the general limit to routes the dashboard calls often', async () => {
    const app = await createTestApp({
      config: { rateLimitPerMinute: 100, authRateLimitPerMinute: 2, secureCookies: false },
    });
    try {
      const agent = await signIn(app, 'developer-a');
      for (let index = 0; index < 5; index += 1) {
        await agent.get('/api/v1/auth/me').expect(200);
      }
    } finally {
      await app.close();
    }
  });

  it('never limits health checks', async () => {
    const app = await createTestApp({ config: { rateLimitPerMinute: 1 } });
    try {
      const server = app.getHttpServer();
      for (let index = 0; index < 5; index += 1) {
        await request(server).get('/api/v1/health/live').expect(200);
      }
    } finally {
      await app.close();
    }
  });
});
