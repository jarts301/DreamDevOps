// Makes sure the login provider knows the sample users, whatever its realm was imported with.
import type { SampleUser } from './demo-company.ts';

export interface KeycloakAdmin {
  /** Such as http://localhost:8081 */
  readonly url: string;
  readonly realm: string;
  readonly username: string;
  readonly password: string;
  /** Replaced in tests. */
  readonly fetch?: typeof fetch;
}

export interface KeycloakUsers {
  /** The user's ID, which becomes the subject of their logins, or undefined if there is none. */
  find(username: string): Promise<string | undefined>;
  /** Finds the user, or creates them with the password if they're missing. Answers their ID. */
  ensure(user: SampleUser, password: string): Promise<string>;
}

/**
 * Keycloak imports its realm only once, so a local stack started before a sample user was
 * added doesn't have them. These find the sample users, and create any that are missing.
 */
export async function keycloakUsers(admin: KeycloakAdmin): Promise<KeycloakUsers> {
  const call = admin.fetch ?? fetch;
  const token = await adminToken(admin, call);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = `${admin.url}/admin/realms/${encodeURIComponent(admin.realm)}/users`;

  const find = async (username: string): Promise<string | undefined> => {
    const response = await call(`${base}?exact=true&username=${encodeURIComponent(username)}`, { headers });
    if (response.status !== 200) {
      throw new Error(`Keycloak answered ${response.status} when looking for ${username}.`);
    }
    return ((await response.json()) as { id: string }[])[0]?.id;
  };

  const ensure = async (user: SampleUser, password: string): Promise<string> => {
    const existing = await find(user.username);
    if (existing !== undefined) {
      return existing;
    }
    const created = await call(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        enabled: true,
        emailVerified: true,
        credentials: [{ type: 'password', value: password, temporary: false }],
      }),
    });
    // 409 means another start made the user at the same moment.
    if (created.status !== 201 && created.status !== 409) {
      throw new Error(`Keycloak answered ${created.status} when creating ${user.username}.`);
    }
    const id = await find(user.username);
    if (id === undefined) {
      throw new Error(`Keycloak has no user ${user.username}, even after creating it.`);
    }
    return id;
  };

  return { find, ensure };
}

async function adminToken(admin: KeycloakAdmin, call: typeof fetch): Promise<string> {
  const response = await call(`${admin.url}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: admin.username,
      password: admin.password,
    }).toString(),
  });
  if (response.status !== 200) {
    throw new Error(`Keycloak refused its administrator's login with ${response.status}. Check KEYCLOAK_ADMIN_PASSWORD.`);
  }
  return ((await response.json()) as { access_token: string }).access_token;
}
