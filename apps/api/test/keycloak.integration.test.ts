import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_USERS } from '../src/demo/demo-company.ts';
import { RequirePermissions } from '../src/http/access.decorators.ts';
import { buildApp } from './test-app.ts';
import { startTestDatabase, type TestDatabase } from './test-database.ts';

const REALM_FILE = fileURLToPath(new URL('../../../infra/local/keycloak/dreamdevops-realm.json', import.meta.url));
// The same setup script the local stack runs, so the test checks the real login flow.
const INIT_SCRIPT = fileURLToPath(new URL('../../../infra/local/ops/keycloak-init.sh', import.meta.url));
const ADMIN = { username: 'test-admin', password: 'fake-dummy-keycloak-admin-password' };

/**
 * A one-time code, as an authenticator app makes it (RFC 6238). Keycloak's setup form
 * carries the raw secret; the base32 form it shows people is the same key, encoded.
 */
function totp(secret: string, time = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const hash = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = hash[hash.length - 1]! & 0xf;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const CLIENT_SECRET = 'fake-dummy-client-secret';
const USER_PASSWORD = 'fake-dummy-user-password';
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

  /** Opens a page and follows Keycloak's own redirects to the page they end on. */
  async follow(url: string): Promise<Response> {
    let response = await this.open(url);
    for (let step = 0; step < 5 && response.status === 302; step += 1) {
      const next = new URL(response.headers.get('location')!, url);
      if (next.origin !== new URL(url).origin) {
        break;
      }
      response = await this.open(next.toString());
    }
    return response;
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
    return this.submitForm(await page.text(), { username, password, credentialId: '' });
  }

  /** Submits a page's form with its hidden fields, plus the given ones. */
  async submitForm(html: string, fields: Record<string, string>): Promise<Response> {
    const action = /action="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
    if (action === undefined) {
      throw new Error('The page has no form.');
    }
    const hidden = Object.fromEntries(
      [...html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)].flatMap(([input]) => {
        const name = /name="([^"]+)"/.exec(input)?.[1];
        const value = /value="([^"]*)"/.exec(input)?.[1] ?? '';
        return name === undefined ? [] : [[name, value]];
      }),
    );
    return this.#fetch(action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...hidden, ...fields }).toString(),
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
          KC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
          KC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
          DREAMDEVOPS_KEYCLOAK_CLIENT_SECRET: CLIENT_SECRET,
          KEYCLOAK_DEV_USER_PASSWORD: USER_PASSWORD,
        })
        .withCopyFilesToContainer([
          { source: REALM_FILE, target: '/opt/keycloak/data/import/dreamdevops-realm.json' },
          { source: INIT_SCRIPT, target: '/tmp/keycloak-init.sh' },
        ])
        .withExposedPorts(8080, 9000)
        .withWaitStrategy(Wait.forHttp('/health/ready', 9000))
        .withStartupTimeout(180_000)
        .start(),
      startTestDatabase(),
    ]);
    const setup = await keycloak.exec(['bash', '/tmp/keycloak-init.sh'], {
      env: {
        KEYCLOAK_URL: 'http://localhost:8080',
        KEYCLOAK_ADMIN_USERNAME: ADMIN.username,
        KEYCLOAK_ADMIN_PASSWORD: ADMIN.password,
        FORGEJO_KEYCLOAK_CLIENT_SECRET: 'fake-dummy-forgejo-client-secret',
        FORGEJO_PUBLIC_URL: 'http://localhost:3000',
        KEYCLOAK_DEV_USER_PASSWORD: USER_PASSWORD,
      },
    });
    if (setup.exitCode !== 0) {
      throw new Error(`The Keycloak setup script failed: ${setup.output}`);
    }
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
    const { agent, submitted } = await logIn('demo-developer', USER_PASSWORD);

    const finished = await finish(agent, submitted);

    expect(finished.status).toBe(302);
    expect(finished.headers.location).toBe('http://localhost:4200/');
    const { body } = await agent.get('/api/v1/auth/me').expect(200);
    expect(body).toMatchObject({
      email: 'demo-developer@example.com',
      displayName: 'Demo Developer',
      companyId: null,
      permissions: [],
      memberships: [],
    });
  });

  it('signs demo users in with the IDs the demo company setup expects', async () => {
    const { agent, submitted } = await logIn('demo-operator', USER_PASSWORD);
    await finish(agent, submitted);

    const superuser = new pg.Pool({ connectionString: database.superuserUrl() });
    const { rows } = await superuser.query<{ subject: string }>('SELECT subject FROM identity.users WHERE email = $1', [
      'demo-operator@example.com',
    ]);
    await superuser.end();
    expect(rows[0]?.subject).toBe(DEMO_USERS.find((user) => user.username === 'demo-operator')!.subject);
  });

  it('refuses a wrong password', async () => {
    const { agent, submitted } = await logIn('demo-company-admin', 'wrong-password');

    expect(submitted.status).toBe(200);
    await expect(submitted.text()).resolves.toContain('Invalid username or password');
    await agent.get('/api/v1/auth/me').expect(401);
  });

  it('asks a platform admin for a second factor, and grants platform permissions after it', async () => {
    const { agent, browser, submitted } = await logIn('dev-platform-admin', USER_PASSWORD);

    // The password alone isn't enough: the platform starts the login again, asking for more.
    const afterPassword = await finish(agent, submitted);
    expect(afterPassword.status).toBe(302);
    const stepUp = new URL(afterPassword.headers.location as string);
    expect(stepUp.pathname).toBe('/api/v1/auth/login');
    expect(stepUp.searchParams.get('mfa')).toBe('1');
    await agent.get('/api/v1/auth/me').expect(401);

    // Keycloak remembers the password, and asks only to set up an authenticator.
    const restarted = await agent.get(stepUp.pathname + stepUp.search).expect(302);
    expect(new URL(restarted.headers.location as string).searchParams.get('acr_values')).toBe('mfa');
    const setupPage = await (await browser.follow(restarted.headers.location as string)).text();
    expect(setupPage).not.toContain('name="password"');
    const secret = /name="totpSecret" value="([^"]+)"/.exec(setupPage)?.[1];
    expect(secret).toBeDefined();
    const configured = await browser.submitForm(setupPage, { totp: totp(secret!), userLabel: 'Test phone' });
    const finished = await finish(agent, configured);

    expect(finished.headers.location).toBe('http://localhost:4200/');
    await agent.get('/api/v1/sample/platform-only').expect(200);
    const { body } = await agent.get('/api/v1/auth/me').expect(200);
    expect(body.permissions).toEqual(['audit:read-own', 'companies:manage', 'editions:manage']);
    expect(body.companyId).toBeNull();
  });

  it('asks a developer for nothing more than the password', async () => {
    const { agent, submitted } = await logIn('demo-developer', USER_PASSWORD);

    const finished = await finish(agent, submitted);

    expect(finished.headers.location).toBe('http://localhost:4200/');
    await agent.get('/api/v1/auth/me').expect(200);
  });

  it('refuses platform permissions without the Keycloak role', async () => {
    const { agent, submitted } = await logIn('demo-company-admin', USER_PASSWORD);
    await finish(agent, submitted);

    await agent.get('/api/v1/sample/platform-only').expect(403);
  });

  it('refuses a code from Keycloak replayed in a new login', async () => {
    const first = await logIn('demo-developer', USER_PASSWORD);
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
    const { agent, submitted } = await logIn('demo-developer', USER_PASSWORD);
    const callback = new URL(submitted.headers.get('location')!);
    callback.searchParams.set('state', 'forged');

    await agent.get(callback.pathname + callback.search).expect(400);
    await agent.get('/api/v1/auth/me').expect(401);
  });

  it('ends the Keycloak session too, so the next login asks for the password', async () => {
    const { agent, browser, submitted } = await logIn('demo-developer', USER_PASSWORD);
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
