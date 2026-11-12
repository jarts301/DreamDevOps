import { currentCompanyId } from '@dreamdevops/shared-kernel';
import type { CompanyMember, CompanyMembers } from '../../src/identity-access/application/company-members.ts';
import type {
  AuthorizationRequest,
  CodeExchange,
  ExternalIdentity,
  IdentityProvider,
  LogoutRequest,
  UserDirectory,
} from '../../src/identity-access/application/ports.ts';
import type { CompanyMembership, UserAccess } from '../../src/identity-access/domain/access.ts';

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
  'viewer-a': [membership(COMPANY_A, 'viewer', 'dashboards:view')],
  'operator-a': [membership(COMPANY_A, 'operator', 'dashboards:view', 'alerts:manage')],
  'viewer-b': [membership(COMPANY_B, 'viewer', 'dashboards:view')],
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

/** Members by company, answered in the current company only, as the real one does. */
export class FakeCompanyMembers implements CompanyMembers {
  readonly byCompany = new Map<string, CompanyMember[]>();

  async list(): Promise<CompanyMember[]> {
    return [...(this.byCompany.get(currentCompanyId()) ?? [])];
  }

  async find(userIds: readonly string[]): Promise<CompanyMember[]> {
    return (await this.list()).filter((member) => userIds.includes(member.userId));
  }

  /** Removes someone from a company, as removing a member does. */
  remove(companyId: string, userId: string): void {
    this.byCompany.set(companyId, (this.byCompany.get(companyId) ?? []).filter((member) => member.userId !== userId));
  }
}
