import { fileURLToPath } from 'node:url';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequirePermissions } from '../src/http/access.decorators.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';

const REALM_FILE = fileURLToPath(new URL('../../../infra/local/keycloak/dreamdevops-realm.json', import.meta.url));
const CLIENT_SECRET = 'test-client-secret';
const USER_PASSWORD = 'test-user-password';
// The realm only accepts this redirect address. The test never opens it: it reads the
// redirect and passes the same path and query to the application directly.
const PUBLIC_URL = 'http://localhost:4000';

@Controller('sample')
class SampleController {
  @RequirePermissions('companies:manage')
  @Get('platform-only')
  platformOnly(): object {
    return { ok: true };
  }
}

/** A small browser for Keycloak's pages: it follows redirects and keeps cookies. */
class KeycloakBrowser {
  readonly #cookies = new Map<string, string>();

  async open(url: string): Promise<Response> {
    return this.#fetch(url, {});
  }

  async #fetch(url: string, init: RequestInit): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Cookie: [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';');
      const separator = pair.indexOf('=');
      this.#cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  }

  /** Submits the login form on the page and returns the response. */
  async submitLogin(page: Response, username: string, password: string): Promise<Response> {
    const html = await page.text();
    const action = /action="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
    if (action === undefined) {
      throw new Error('The login page has no form.');
    }
    return this.#fetch(action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password, credentialId: '' }).toString(),
    });
  }
}

describe('login through a real Keycloak', () => {
  let keycloak: StartedTestContainer;
  let database: TestDatabase;
  let app: INestApplication;

  /** Runs the whole flow as a browser would, and returns the outcome. */
  const logIn = async (username: string, password: string, browser = new KeycloakBrowser()) => {
    const agent = request.agent(app.getHttpServer());
    const start = await agent.get('/api/v1/auth/login').expect(302);
    const page = await browser.open(start.headers.location as string);
    const submitted = await browser.submitLogin(page, username, password);
    return { agent, browser, submitted };
  };

  const finish = async (agent: ReturnType<typeof request.agent>, submitted: Response) => {
    expect(submitted.status).toBe(302);
    const callback = new URL(submitted.headers.get('location')!);
    expect(callback.origin).toBe(PUBLIC_URL);
    return agent.get(callback.pathname + callback.search);
  };

  beforeAll(async () => {
    [keycloak, database] = await Promise.all([
      new GenericContainer('quay.io/keycloak/keycloak:26.8.1')
        .withCommand(['start-dev', '--import-realm'])
        .withEnvironment({
          KC_HEALTH_ENABLED: 'true',
          DREAMDEVOPS_KEYCLOAK_CLIENT_SECRET: CLIENT_SECRET,
          KEYCLOAK_DEV_USER_PASSWORD: USER_PASSWORD,
        })
        .withCopyFilesToContainer([{ source: REALM_FILE, target: '/opt/keycloak/data/import/dreamdevops-realm.json' }])
        .withExposedPorts(8080, 9000)
        .withWaitStrategy(Wait.forHttp('/health/ready', 9000))
        .withStartupTimeout(180_000)
        .start(),
      startTestDatabase(),
    ]);
    app = await buildApp({
      controllers: [SampleController],
      config: {
        databaseUrl: database.urlFor('app'),
        publicUrl: PUBLIC_URL,
        dashboardUrl: 'http://localhost:4200/',
        secureCookies: false,
        keycloakIssuerUrl: `http://${keycloak.getHost()}:${keycloak.getMappedPort(8080)}/realms/dreamdevops`,
        keycloakClientId: 'dreamdevops-dashboard',
        keycloakClientSecret: CLIENT_SECRET,
      },
    });
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await Promise.all([keycloak?.stop(), database?.stop()]);
  });

  it('signs a user in and creates their session', async () => {
    const { agent, submitted } = await logIn('dev-developer', USER_PASSWORD);

    const finished = await finish(agent, submitted);

    expect(finished.status).toBe(302);
    expect(finished.headers.location).toBe('http://localhost:4200/');
    const { body } = await agent.get('/api/v1/auth/me').expect(200);
    expect(body).toMatchObject({
      email: 'dev-developer@example.com',
      displayName: 'Dev Developer',
      companyId: null,
      permissions: [],
      memberships: [],
    });
  });

  it('refuses a wrong password', async () => {
    const { agent, submitted } = await logIn('dev-company-admin', 'wrong-password');

    expect(submitted.status).toBe(200);
    await expect(submitted.text()).resolves.toContain('Invalid username or password');
    await agent.get('/api/v1/auth/me').expect(401);
  });

  it('grants platform permissions from the Keycloak role', async () => {
    const { agent, submitted } = await logIn('dev-platform-admin', USER_PASSWORD);
    await finish(agent, submitted);

    await agent.get('/api/v1/sample/platform-only').expect(200);
    const { body } = await agent.get('/api/v1/auth/me').expect(200);
    expect(body.permissions).toEqual(['audit:read-own', 'companies:manage']);
    expect(body.companyId).toBeNull();
  });

  it('refuses platform permissions without the Keycloak role', async () => {
    const { agent, submitted } = await logIn('dev-company-admin', USER_PASSWORD);
    await finish(agent, submitted);

    await agent.get('/api/v1/sample/platform-only').expect(403);
  });

  it('refuses a code from Keycloak replayed in a new login', async () => {
    const first = await logIn('dev-developer', USER_PASSWORD);
    const callback = new URL(first.submitted.headers.get('location')!);
    await first.agent.get(callback.pathname + callback.search).expect(302);

    const attacker = request.agent(app.getHttpServer());
    const started = await attacker.get('/api/v1/auth/login').expect(302);
    const state = new URL(started.headers.location as string).searchParams.get('state')!;
    callback.searchParams.set('state', state);

    await attacker.get(callback.pathname + callback.search).expect(401);
    await attacker.get('/api/v1/auth/me').expect(401);
  });

  it('rejects a callback whose state does not match', async () => {
    const { agent, submitted } = await logIn('dev-developer', USER_PASSWORD);
    const callback = new URL(submitted.headers.get('location')!);
    callback.searchParams.set('state', 'forged');

    await agent.get(callback.pathname + callback.search).expect(400);
    await agent.get('/api/v1/auth/me').expect(401);
  });

  it('ends the Keycloak session too, so the next login asks for the password', async () => {
    const { agent, browser, submitted } = await logIn('dev-developer', USER_PASSWORD);
    await finish(agent, submitted);

    const { body } = await agent.post('/api/v1/auth/logout').expect(200);
    const ended = await browser.open(body.logoutUrl as string);
    expect(ended.status).toBe(302);
    expect(ended.headers.get('location')).toBe('http://localhost:4200/');

    const nextAgent = request.agent(app.getHttpServer());
    const start = await nextAgent.get('/api/v1/auth/login').expect(302);
    const page = await browser.open(start.headers.location as string);
    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toContain('name="password"');
  });
});
