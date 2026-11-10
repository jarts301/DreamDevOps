import type { ExternalIdentity } from '../identity-access/application/ports.ts';

export interface KeycloakAdminOptions {
  /** The realm's issuer, such as http://localhost:8081/realms/dreamdevops. */
  readonly issuerUrl: string;
  /** Keycloak's own administrator, in its master realm. */
  readonly username: string;
  readonly password: string;
  readonly timeoutMs?: number;
}

interface KeycloakUser {
  readonly id: string;
  readonly username: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly firstName?: string;
  readonly lastName?: string;
}

/** A sample account as the login provider would describe it at login. */
export interface SampleIdentity extends Omit<ExternalIdentity, 'idToken' | 'platformAdmin'> {
  readonly username: string;
  /** Whether it was just created. */
  readonly created: boolean;
}

/**
 * Keycloak's admin API, as local sample data needs it: finds sample accounts, and
 * creates the ones an older local realm doesn't have yet. Development only.
 */
export class KeycloakAdmin {
  readonly #base: string;
  readonly #realm: string;
  readonly #options: KeycloakAdminOptions;
  #token: string | null = null;

  constructor(options: KeycloakAdminOptions) {
    const issuer = new URL(options.issuerUrl);
    const match = /^(.*)\/realms\/([^/]+)\/?$/.exec(issuer.pathname);
    if (match === null) {
      throw new Error(`${options.issuerUrl} isn't a Keycloak realm's address.`);
    }
    this.#base = `${issuer.origin}${match[1]}`;
    this.#realm = decodeURIComponent(match[2]!);
    this.#options = options;
  }

  /**
   * The account, created with the password if it doesn't exist. An existing account is
   * left as it is, password included, so nobody's changes are undone.
   */
  async ensureUser(account: {
    readonly username: string;
    readonly email: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly password: string;
  }): Promise<SampleIdentity> {
    const existing = await this.#find(account.username);
    if (existing !== null) {
      return toIdentity(existing, false);
    }
    const response = await this.#request('POST', `/admin/realms/${encodeURIComponent(this.#realm)}/users`, {
      username: account.username,
      email: account.email,
      firstName: account.firstName,
      lastName: account.lastName,
      enabled: true,
      emailVerified: true,
      credentials: [{ type: 'password', value: account.password, temporary: false }],
    });
    if (response.status !== 201 && response.status !== 409) {
      throw new Error(`Keycloak refused to create ${account.username}: status ${response.status}.`);
    }
    const created = await this.#find(account.username);
    if (created === null) {
      throw new Error(`Keycloak didn't keep ${account.username}.`);
    }
    return toIdentity(created, response.status === 201);
  }

  /** An existing account, or null. */
  async findUser(username: string): Promise<SampleIdentity | null> {
    const user = await this.#find(username);
    return user === null ? null : toIdentity(user, false);
  }

  async #find(username: string): Promise<KeycloakUser | null> {
    const response = await this.#request(
      'GET',
      `/admin/realms/${encodeURIComponent(this.#realm)}/users?exact=true&username=${encodeURIComponent(username)}`,
    );
    if (response.status !== 200) {
      throw new Error(`Keycloak couldn't look up ${username}: status ${response.status}.`);
    }
    const users = (await response.json()) as KeycloakUser[];
    return users.find((user) => user.username === username) ?? null;
  }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.#accessToken();
    return fetch(`${this.#base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(this.#options.timeoutMs ?? 10_000),
    });
  }

  async #accessToken(): Promise<string> {
    if (this.#token !== null) {
      return this.#token;
    }
    const response = await fetch(`${this.#base}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: this.#options.username,
        password: this.#options.password,
      }),
      signal: AbortSignal.timeout(this.#options.timeoutMs ?? 10_000),
    });
    if (response.status !== 200) {
      throw new Error(`Keycloak refused its administrator's login: status ${response.status}. Check KEYCLOAK_ADMIN_USERNAME and KEYCLOAK_ADMIN_PASSWORD.`);
    }
    this.#token = ((await response.json()) as { access_token: string }).access_token;
    return this.#token;
  }
}

function toIdentity(user: KeycloakUser, created: boolean): SampleIdentity {
  const name = [user.firstName, user.lastName].filter((part) => part !== undefined && part !== '').join(' ');
  const email = (user.email ?? `${user.username}@example.com`).toLowerCase();
  return {
    username: user.username,
    subject: user.id,
    email,
    emailVerified: user.emailVerified === true,
    // As Keycloak's "name" claim has it, so a later login keeps the same name.
    displayName: name === '' ? email : name,
    created,
  };
}
