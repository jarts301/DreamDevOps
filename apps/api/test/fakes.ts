import type {
  AuthorizationRequest,
  CodeExchange,
  ExternalIdentity,
  IdentityProvider,
  LogoutRequest,
  UserDirectory,
} from '../src/identity-access/application/ports.ts';
import type { CompanyMembership, UserAccess } from '../src/identity-access/domain/access.ts';
import type { EmailMessage, Mailer } from '../src/notifications/application/ports.ts';
import {
  type GitOrganization,
  type GitProvider,
  PermanentProvisioningError,
} from '../src/tenancy/application/ports.ts';

export const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
export const COMPANY_B = '00000000-0000-4000-8000-00000000000b';

const identity = (name: string, platformAdmin = false): ExternalIdentity => ({
  subject: `fake|${name}`,
  email: `${name}@example.com`,
  emailVerified: true,
  displayName: name,
  platformAdmin,
  idToken: `id-token-of-${name}`,
});

/** Lets a test sign in as anyone by name. It never ships, because it lives in the tests. */
export class FakeIdentityProvider implements IdentityProvider {
  async authorizationUrl(request: AuthorizationRequest): Promise<string> {
    const url = new URL(request.redirectUri);
    url.searchParams.set('code', request.loginHint ?? '');
    url.searchParams.set('state', request.state);
    return url.toString();
  }

  async exchangeCode(exchange: CodeExchange): Promise<ExternalIdentity | null> {
    const name = exchange.callbackUrl.searchParams.get('code') ?? '';
    if (!/^[a-z][a-z-]*$/.test(name) || name === 'constructor' || name.startsWith('unknown')) {
      return null;
    }
    return identity(name, name === 'platform-admin');
  }

  async logoutUrl(request: LogoutRequest): Promise<string | null> {
    return `http://login.test/logout?hint=${request.idToken ?? ''}&next=${encodeURIComponent(request.postLogoutRedirectUri)}`;
  }
}

const membership = (companyId: string, role: string, ...permissions: string[]): CompanyMembership => ({
  companyId,
  companyName: companyId === COMPANY_A ? 'Company A' : 'Company B',
  role,
  permissions,
});

const SAMPLE_MEMBERSHIPS: Readonly<Record<string, readonly CompanyMembership[]>> = {
  'tech-lead-a': [membership(COMPANY_A, 'tech-lead', 'applications:read', 'applications:write')],
  'developer-a': [membership(COMPANY_A, 'developer', 'applications:read')],
  'tech-lead-b': [membership(COMPANY_B, 'tech-lead', 'applications:read', 'applications:write')],
  consultant: [
    membership(COMPANY_A, 'developer', 'applications:read'),
    membership(COMPANY_B, 'tech-lead', 'applications:read', 'applications:write'),
  ],
};

/** A fake UserDirectory for fast tests. The same contract tests run against this and PostgreSQL. */
export class InMemoryUserDirectory implements UserDirectory {
  readonly #users = new Map<string, UserAccess>();
  readonly #idsBySubject = new Map<string, string>();

  async recordLogin(external: ExternalIdentity): Promise<string> {
    const id = this.#idsBySubject.get(external.subject) ?? crypto.randomUUID();
    this.#idsBySubject.set(external.subject, id);
    const previous = this.#users.get(id);
    const name = external.subject.replace('fake|', '');
    this.#users.set(id, {
      userId: id,
      subject: external.subject,
      email: external.email,
      emailVerified: external.emailVerified,
      displayName: external.displayName,
      platformPermissions: external.platformAdmin ? ['audit:read-own', 'companies:manage', 'editions:manage'] : [],
      memberships: previous?.memberships ?? SAMPLE_MEMBERSHIPS[name] ?? [],
    });
    return id;
  }

  async loadAccess(userId: string): Promise<UserAccess | null> {
    return this.#users.get(userId) ?? null;
  }
}

/** Records organizations in memory, and can be told to fail. */
export class FakeGitProvider implements GitProvider {
  readonly organizations = new Map<string, GitOrganization>();
  /** Errors to throw, one per call, before calls start succeeding. */
  readonly failures: Error[] = [];
  calls = 0;

  async ensureOrganization(organization: GitOrganization): Promise<string> {
    this.calls += 1;
    const failure = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    const existing = this.organizations.get(organization.name);
    if (existing !== undefined && existing.companyId !== organization.companyId) {
      throw new PermanentProvisioningError(`The Git organization name "${organization.name}" is already taken.`);
    }
    this.organizations.set(organization.name, organization);
    return `org-${organization.name}`;
  }
}

/** Keeps sent emails in memory instead of sending them. */
export class FakeMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  failing = false;

  async send(message: EmailMessage): Promise<void> {
    if (this.failing) {
      throw new Error('Mail server unavailable');
    }
    this.sent.push(message);
  }
}
