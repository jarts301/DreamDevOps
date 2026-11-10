import { describe, expect, it } from 'vitest';
import { normalizeName } from '../src/shared/names.ts';
import { refPath, segment } from '../src/shared/forgejo/forgejo-api.ts';
import { normalizeApplicationName } from '../src/catalog/domain/application.ts';
import { normalizeCompanyName } from '../src/tenancy/domain/company.ts';

describe('normalizeName', () => {
  const rules = { minLength: 2, maxLength: 5, refuseControlCharacters: true };

  it('trims, and turns runs of spaces, tabs and line breaks into one space', () => {
    expect(normalizeName('  a \t\n b ', rules)).toBe('a b');
  });

  it('refuses what is too short, too long, or not text', () => {
    for (const value of ['a', 'abcdef', 42, null, undefined]) {
      expect(normalizeName(value, rules)).toBeNull();
    }
  });

  it('refuses control characters only when asked to', () => {
    expect(normalizeName('a\u0000b', rules)).toBeNull();
    expect(normalizeName('a\u0000b', { ...rules, refuseControlCharacters: false })).toBe('a\u0000b');
  });

  it('is how company and application names are cleaned up', () => {
    expect(normalizeCompanyName('  Acme   Corp ')).toBe('Acme Corp');
    expect(normalizeApplicationName('  Billing   API ')).toBe('Billing API');
    expect(() => normalizeCompanyName('Bad\u0000name')).toThrow('Enter a company name between 2 and 80 characters.');
  });
});

describe('Forgejo paths', () => {
  it('escape names, but keep the slashes of branch and tag names', () => {
    expect(segment('a b/c')).toBe('a%20b%2Fc');
    expect(refPath('release/1.0.0')).toBe('release/1.0.0');
    expect(refPath('feature/a b')).toBe('feature/a%20b');
  });
});
