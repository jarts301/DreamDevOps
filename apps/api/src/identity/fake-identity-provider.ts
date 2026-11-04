import type { AuthorizationRequest, CodeExchange, IdentityProvider } from './identity-provider.ts';
import type { Principal } from './principal.ts';

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const COMPANY_B = '00000000-0000-4000-8000-00000000000b';

/** Sample users for local development. Choose one with /auth/login?as=<name>. */
export const FAKE_USERS: Readonly<Record<string, Principal>> = {
  'tech-lead-a': {
    subject: 'fake|tech-lead-a',
    displayName: 'Tech Lead, Company A',
    companyId: COMPANY_A,
    permissions: ['applications:read', 'applications:write'],
  },
  'developer-a': {
    subject: 'fake|developer-a',
    displayName: 'Developer, Company A',
    companyId: COMPANY_A,
    permissions: ['applications:read'],
  },
  'tech-lead-b': {
    subject: 'fake|tech-lead-b',
    displayName: 'Tech Lead, Company B',
    companyId: COMPANY_B,
    permissions: ['applications:read', 'applications:write'],
  },
  'platform-admin': {
    subject: 'fake|platform-admin',
    displayName: 'Platform Admin',
    companyId: null,
    permissions: ['companies:manage'],
  },
};

/**
 * Lets anyone sign in as a sample user, so it must never reach production: loadConfig
 * refuses to start it there. It skips the login page by redirecting straight back,
 * but otherwise follows the same steps as the real flow.
 */
export class FakeIdentityProvider implements IdentityProvider {
  readonly #users: Readonly<Record<string, Principal>>;

  constructor(users: Readonly<Record<string, Principal>> = FAKE_USERS) {
    this.#users = users;
  }

  authorizationUrl(request: AuthorizationRequest): string {
    const url = new URL(request.redirectUri);
    url.searchParams.set('code', request.loginHint ?? '');
    url.searchParams.set('state', request.state);
    return url.toString();
  }

  async exchangeCode(exchange: CodeExchange): Promise<Principal | null> {
    return Object.hasOwn(this.#users, exchange.code) ? (this.#users[exchange.code] ?? null) : null;
  }
}
