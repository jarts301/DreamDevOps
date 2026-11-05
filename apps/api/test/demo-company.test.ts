import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEMO_COMPANY, DEMO_MEMBERS, PLATFORM_ADMIN } from '../scripts/demo-company.ts';
import { keycloakUsers } from '../scripts/keycloak-users.ts';
import { parseCompanySlug, parseName } from '../src/tenancy/domain/names.ts';

const REALM = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../infra/local/keycloak/dreamdevops-realm.json', import.meta.url)), 'utf8'),
) as { users: { username: string; email: string; firstName: string; lastName: string; emailVerified: boolean; realmRoles?: string[]; credentials: { value: string }[] }[] };

// The company roles, written out independently of the migrations.
const COMPANY_ROLES = ['company-admin', 'tech-lead', 'developer', 'operator', 'viewer'];

describe('the demo company', () => {
  it('has a valid name and slug', () => {
    expect(parseName(DEMO_COMPANY.name, 'company')).toBe(DEMO_COMPANY.name);
    expect(parseCompanySlug(DEMO_COMPANY.slug)).toBe(DEMO_COMPANY.slug);
  });

  it('has exactly one member in each company role', () => {
    expect(DEMO_MEMBERS.map((member) => member.role).sort()).toEqual([...COMPANY_ROLES].sort());
  });

  it.each(DEMO_MEMBERS.map((member) => [member.username, member] as const))(
    'lists %s in the realm file, as the seed defines them, with the sample password',
    (_username, member) => {
      const user = REALM.users.find((candidate) => candidate.username === member.username);

      expect(user).toMatchObject({
        email: member.email,
        firstName: member.firstName,
        lastName: member.lastName,
        emailVerified: true,
      });
      expect(user?.credentials[0]?.value).toBe('${KEYCLOAK_DEV_USER_PASSWORD}');
      expect(user?.realmRoles ?? []).not.toContain('platform-admin');
    },
  );

  it('is created by the Platform Admin from the realm file', () => {
    expect(REALM.users.find((user) => user.username === PLATFORM_ADMIN.username)).toMatchObject({
      email: PLATFORM_ADMIN.email,
      realmRoles: ['platform-admin'],
    });
  });
});

describe('keycloakUsers', () => {
  const user = DEMO_MEMBERS[1]!;

  /** Answers requests in order, as Keycloak would, and records what was asked. */
  const keycloak = (...answers: (readonly [number, unknown?])[]) => {
    const calls: { method: string; url: string; body: string | undefined }[] = [];
    const fetchStub = (async (url: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? 'GET', url, body: init.body as string | undefined });
      const [status, body] = answers.shift() ?? [500];
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    const admin = { url: 'http://login.test', realm: 'dreamdevops', username: 'admin', password: 'secret', fetch: fetchStub };
    return { admin, calls };
  };

  it('signs in as the administrator, and finds a user who is there', async () => {
    const { admin, calls } = keycloak([200, { access_token: 'token' }], [200, [{ id: 'id-1' }]]);

    const users = await keycloakUsers(admin);

    await expect(users.ensure(user, 'password')).resolves.toBe('id-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST http://login.test/realms/master/protocol/openid-connect/token',
      'GET http://login.test/admin/realms/dreamdevops/users?exact=true&username=demo-tech-lead',
    ]);
  });

  it('creates a user who is missing, verified, with the sample password', async () => {
    const { admin, calls } = keycloak([200, { access_token: 'token' }], [200, []], [201], [200, [{ id: 'new-id' }]]);

    await expect((await keycloakUsers(admin)).ensure(user, 'sample-password')).resolves.toBe('new-id');

    expect(JSON.parse(calls[2]!.body!)).toEqual({
      username: 'demo-tech-lead',
      email: 'demo-tech-lead@example.com',
      firstName: 'Demo',
      lastName: 'Tech Lead',
      enabled: true,
      emailVerified: true,
      credentials: [{ type: 'password', value: 'sample-password', temporary: false }],
    });
  });

  it('finds a user someone else created at the same moment', async () => {
    const { admin } = keycloak([200, { access_token: 'token' }], [200, []], [409], [200, [{ id: 'theirs' }]]);

    await expect((await keycloakUsers(admin)).ensure(user, 'password')).resolves.toBe('theirs');
  });

  it('only looks a user up when asked to find them', async () => {
    const { admin, calls } = keycloak([200, { access_token: 'token' }], [200, []]);

    await expect((await keycloakUsers(admin)).find('dev-platform-admin')).resolves.toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(['POST', 'GET']);
  });

  it('says which setting to check when the administrator is refused', async () => {
    const { admin } = keycloak([401]);

    await expect(keycloakUsers(admin)).rejects.toThrow('Check KEYCLOAK_ADMIN_PASSWORD');
  });
});
