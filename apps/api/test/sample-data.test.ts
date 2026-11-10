import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvalidConfigError, loadConfig } from '../src/config/app-config.ts';
import { KeycloakAdmin } from '../src/sample-data/keycloak-admin.ts';
import { SAMPLE_ACCOUNTS, SAMPLE_PLATFORM_ADMIN } from '../src/sample-data/sample-accounts.ts';
import { HttpStub } from './support/http-stub.ts';

const REALM = fileURLToPath(new URL('../../../infra/local/keycloak/dreamdevops-realm.json', import.meta.url));

describe('the sample accounts', () => {
  it('cover every company role once', () => {
    expect(SAMPLE_ACCOUNTS.map((account) => account.role).sort()).toEqual(
      ['company-admin', 'developer', 'operator', 'tech-lead', 'viewer'],
    );
    // The Company Admin joins first, so the company always has one to invite the rest.
    expect(SAMPLE_ACCOUNTS[0]!.role).toBe('company-admin');
  });

  it('are in the local realm with the sample password, so a new local stack has them', () => {
    const realm = JSON.parse(readFileSync(REALM, 'utf8')) as {
      users: { username: string; email: string; emailVerified: boolean; realmRoles?: string[]; credentials: { value: string }[] }[];
    };
    const byName = new Map(realm.users.map((user) => [user.username, user]));

    for (const username of [SAMPLE_PLATFORM_ADMIN, ...SAMPLE_ACCOUNTS.map((account) => account.username)]) {
      const user = byName.get(username);
      expect(user, username).toBeDefined();
      expect(user!.email).toBe(`${username}@example.com`);
      expect(user!.emailVerified).toBe(true);
      expect(user!.credentials[0]!.value).toBe('${KEYCLOAK_DEV_USER_PASSWORD}');
    }
    expect(byName.get(SAMPLE_PLATFORM_ADMIN)!.realmRoles).toEqual(['platform-admin']);
  });
});

describe('sample data settings', () => {
  const valid = {
    API_DATABASE_URL: 'postgres://app@localhost/dreamdevops',
    API_PUBLIC_URL: 'http://localhost:4000',
    DASHBOARD_URL: 'http://localhost:4200',
    KEYCLOAK_ISSUER_URL: 'http://localhost:8081/realms/dreamdevops',
    KEYCLOAK_CLIENT_ID: 'dreamdevops-dashboard',
    KEYCLOAK_CLIENT_SECRET: 'fake-dummy-client-secret',
    RELAY_DATABASE_URL: 'postgres://relay@localhost/dreamdevops',
    JOBS_DATABASE_URL: 'postgres://jobs@localhost/dreamdevops',
    FORGEJO_URL: 'http://localhost:3000',
    FORGEJO_BOT_USERNAME: 'dreamdevops-bot',
    FORGEJO_BOT_PASSWORD: 'fake-dummy-bot-password',
    FORGEJO_WEBHOOK_SECRET: 'fake-dummy-webhook-secret',
    SMTP_HOST: 'smtp.example.com',
    SMTP_FROM: 'DreamDevOps <no-reply@example.com>',
  };
  const sample = {
    SAMPLE_DATA: 'on',
    KEYCLOAK_ADMIN_USERNAME: 'platform-admin',
    KEYCLOAK_ADMIN_PASSWORD: 'fake-dummy-keycloak-admin-password',
    KEYCLOAK_DEV_USER_PASSWORD: 'fake-dummy-sample-user-password',
  };

  it('are off unless asked for', () => {
    expect(loadConfig(valid).sampleData).toBeNull();
    expect(loadConfig({ ...valid, ...sample }).sampleData).toEqual({
      keycloakAdminUsername: 'platform-admin',
      keycloakAdminPassword: 'fake-dummy-keycloak-admin-password',
      password: 'fake-dummy-sample-user-password',
    });
  });

  it('need Keycloak’s administrator and the sample password, and never run in production', () => {
    expect(() => loadConfig({ ...valid, ...sample, KEYCLOAK_DEV_USER_PASSWORD: '' })).toThrow('KEYCLOAK_DEV_USER_PASSWORD must be set.');
    expect(() => loadConfig({ ...valid, ...sample, KEYCLOAK_ADMIN_PASSWORD: '' })).toThrow('KEYCLOAK_ADMIN_PASSWORD must be set.');
    expect(() => loadConfig({ ...valid, SAMPLE_DATA: 'yes' })).toThrow(InvalidConfigError);
    expect(() => loadConfig({ ...valid, ...sample, NODE_ENV: 'production' })).toThrow('SAMPLE_DATA is for local development only.');
  });
});

describe('the Keycloak admin client', () => {
  const keycloak = new HttpStub();
  let admin: KeycloakAdmin;
  const account = {
    username: 'dev-tech-lead',
    email: 'dev-tech-lead@example.com',
    firstName: 'Dev',
    lastName: 'Tech Lead',
    password: 'fake-dummy-sample-user-password',
  };
  const stored = { id: 'kc-1', username: 'dev-tech-lead', email: 'Dev-Tech-Lead@example.com', emailVerified: true, firstName: 'Dev', lastName: 'Tech Lead' };

  beforeAll(async () => {
    await keycloak.start();
  });

  afterAll(async () => {
    await keycloak.stop();
  });

  beforeEach(() => {
    keycloak.reset();
    keycloak.on('POST', '/realms/master/protocol/openid-connect/token', { body: { access_token: 'fake-dummy-token' } });
    admin = new KeycloakAdmin({ issuerUrl: `${keycloak.url}/realms/dreamdevops`, username: 'platform-admin', password: 'fake-dummy-admin' });
  });

  it('signs in as Keycloak’s administrator, and finds an account by its exact name', async () => {
    keycloak.on('GET', '/admin/realms/dreamdevops/users?exact=true&username=dev-tech-lead', { body: [stored] });

    expect(await admin.findUser('dev-tech-lead')).toEqual({
      username: 'dev-tech-lead',
      subject: 'kc-1',
      email: 'dev-tech-lead@example.com',
      emailVerified: true,
      displayName: 'Dev Tech Lead',
      created: false,
    });
    const [token, lookup] = keycloak.requests;
    expect(token!.body).toBe('grant_type=password&client_id=admin-cli&username=platform-admin&password=fake-dummy-admin');
    expect(lookup!.headers.authorization).toBe('Bearer fake-dummy-token');
  });

  it('leaves an existing account as it is, password included', async () => {
    keycloak.on('GET', /\/users\?/, { body: [stored] });

    expect((await admin.ensureUser(account)).created).toBe(false);

    expect(keycloak.calls().filter((call) => call.startsWith('POST /admin'))).toEqual([]);
  });

  it('creates a missing account, verified, with the sample password', async () => {
    let created = false;
    keycloak.on('GET', /\/users\?/, () => ({ body: created ? [stored] : [] }));
    keycloak.on('POST', '/admin/realms/dreamdevops/users', () => {
      created = true;
      return { status: 201 };
    });

    expect(await admin.ensureUser(account)).toMatchObject({ subject: 'kc-1', created: true });

    const request = keycloak.requests.find((candidate) => candidate.method === 'POST' && candidate.path.startsWith('/admin'))!;
    expect(request.body).toEqual({
      username: 'dev-tech-lead',
      email: 'dev-tech-lead@example.com',
      firstName: 'Dev',
      lastName: 'Tech Lead',
      enabled: true,
      emailVerified: true,
      credentials: [{ type: 'password', value: 'fake-dummy-sample-user-password', temporary: false }],
    });
  });

  it('says when its administrator can’t sign in', async () => {
    keycloak.on('POST', '/realms/master/protocol/openid-connect/token', { status: 401, body: { error: 'invalid_grant' } });

    await expect(admin.findUser('dev-tech-lead')).rejects.toThrow(
      "Keycloak refused its administrator's login: status 401. Check KEYCLOAK_ADMIN_USERNAME and KEYCLOAK_ADMIN_PASSWORD.",
    );
  });

  it('needs a realm’s address', () => {
    expect(() => new KeycloakAdmin({ issuerUrl: 'http://localhost:8081/', username: 'a', password: 'b' })).toThrow(
      "isn't a Keycloak realm's address",
    );
  });
});
