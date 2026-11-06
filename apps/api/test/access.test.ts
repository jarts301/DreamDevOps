import { describe, expect, it } from 'vitest';
import { hasPermissions, toPrincipal, type UserAccess } from '../src/identity-access/domain/access.ts';
import { normalizeEmail } from '../src/identity-access/domain/email.ts';
import { AccessError } from '../src/identity-access/domain/errors.ts';

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';

const access = (overrides: Partial<UserAccess> = {}): UserAccess => ({
  userId: 'user-1',
  subject: 'subject-1',
  email: 'user@example.com',
  emailVerified: true,
  displayName: 'User',
  platformPermissions: [],
  memberships: [
    { companyId: COMPANY_A, companyName: 'Company A', role: 'developer', permissions: ['code:push'] },
    { companyId: COMPANY_B, companyName: 'Company B', role: 'tech-lead', permissions: ['releases:start', 'code:push'] },
  ],
  ...overrides,
});

describe('toPrincipal', () => {
  it('uses the chosen company and its permissions only', () => {
    const principal = toPrincipal(access(), COMPANY_B);

    expect(principal.companyId).toBe(COMPANY_B);
    expect(principal.companyName).toBe('Company B');
    expect(principal.role).toBe('tech-lead');
    expect(principal.permissions).toEqual(['releases:start', 'code:push']);
  });

  it('does not mix permissions between companies', () => {
    expect(toPrincipal(access(), COMPANY_A).permissions).not.toContain('releases:start');
  });

  it('defaults to the oldest membership', () => {
    expect(toPrincipal(access(), null).companyId).toBe(COMPANY_A);
  });

  it('ignores a chosen company the user no longer belongs to', () => {
    const principal = toPrincipal(access(), 'company-removed');

    expect(principal.companyId).toBe(COMPANY_A);
    expect(principal.role).toBe('developer');
  });

  it('gives a user with no membership no company', () => {
    const principal = toPrincipal(access({ memberships: [] }), null);

    expect(principal.companyId).toBeNull();
    expect(principal.role).toBeNull();
    expect(principal.permissions).toEqual([]);
  });

  it('keeps platform permissions separate from any company', () => {
    const principal = toPrincipal(access({ platformPermissions: ['companies:manage'], memberships: [] }), null);

    expect(principal.companyId).toBeNull();
    expect(principal.permissions).toEqual(['companies:manage']);
  });

  it('lists memberships without their permissions', () => {
    expect(toPrincipal(access(), null).memberships).toEqual([
      { companyId: COMPANY_A, companyName: 'Company A', role: 'developer' },
      { companyId: COMPANY_B, companyName: 'Company B', role: 'tech-lead' },
    ]);
  });
});

describe('hasPermissions', () => {
  const principal = toPrincipal(access(), COMPANY_B);

  it('allows a held permission', () => {
    expect(hasPermissions(principal, ['releases:start'])).toBe(true);
  });

  it('refuses a permission that is not held', () => {
    expect(hasPermissions(principal, ['company-users:manage'])).toBe(false);
  });

  it('requires every listed permission', () => {
    expect(hasPermissions(principal, ['releases:start', 'code:push'])).toBe(true);
    expect(hasPermissions(principal, ['releases:start', 'audit:read'])).toBe(false);
  });

  it('does not match the same action on another subject', () => {
    expect(hasPermissions(principal, ['deployments:start'])).toBe(false);
  });

  it('refuses everything for a user with no permissions', () => {
    expect(hasPermissions(toPrincipal(access({ memberships: [] }), null), ['code:push'])).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Person@Example.COM ')).toBe('person@example.com');
  });

  it.each([undefined, 42, '', 'no-at-sign', 'a@b', 'a b@example.com', `${'x'.repeat(250)}@example.com`])(
    'rejects %j',
    (value) => {
      expect(() => normalizeEmail(value)).toThrow(AccessError);
    },
  );
});
