import { describe, expect, it } from 'vitest';
import { ROLE_NAMES } from '../src/identity-access/roles.ts';
import { ALL_PERMISSIONS } from '../src/permissions.ts';

describe('the permissions contexts declare', () => {
  it('are each declared once, by one context', () => {
    const permissions = ALL_PERMISSIONS.map((grant) => grant.permission);

    expect(new Set(permissions).size).toBe(permissions.length);
  });

  it('are written as subject:action', () => {
    for (const { permission } of ALL_PERMISSIONS) {
      expect(permission).toMatch(/^[a-z]+(?:-[a-z]+)*:[a-z]+(?:-[a-z]+)*$/);
    }
  });

  it('go by default to roles that exist, each at least one, and none twice', () => {
    const roles = new Set([...Object.keys(ROLE_NAMES), 'platform-admin']);
    for (const grant of ALL_PERMISSIONS) {
      expect(grant.roles.length, grant.permission).toBeGreaterThan(0);
      expect(new Set(grant.roles).size, grant.permission).toBe(grant.roles.length);
      expect(grant.roles.filter((role) => !roles.has(role)), grant.permission).toEqual([]);
    }
  });

  it('keep platform permissions to the platform admin, and company ones to company roles', () => {
    for (const grant of ALL_PERMISSIONS) {
      const platform = grant.roles.includes('platform-admin');
      expect(platform ? grant.roles : [], grant.permission).toEqual(platform ? ['platform-admin'] : []);
    }
  });
});
