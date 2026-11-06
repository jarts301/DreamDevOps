import { describe, expect, it } from 'vitest';
import { normalizeCompanyName, numberedSlug, slugFromName } from '../src/tenancy/domain/company.ts';
import { TenancyError } from '../src/tenancy/domain/errors.ts';

describe('company names', () => {
  it('trims and collapses spaces, including line breaks', () => {
    expect(normalizeCompanyName('  Acme   Industries ')).toBe('Acme Industries');
    expect(normalizeCompanyName('Line\nbreak')).toBe('Line break');
  });

  it.each([undefined, 42, '', ' a ', 'x'.repeat(81), 'Bad\u0000Name'])('rejects %j', (value) => {
    expect(() => normalizeCompanyName(value)).toThrow(TenancyError);
  });
});

describe('slugs', () => {
  it.each([
    ['Acme Industries', 'acme-industries'],
    ['Café Ñandú S.A.', 'cafe-nandu-s-a'],
    ['  --Hello__World--  ', 'hello-world'],
    ['ACME 2026', 'acme-2026'],
  ])('makes %j into %j', (name, slug) => {
    expect(slugFromName(name)).toBe(slug);
  });

  it('pads names with too few usable characters', () => {
    expect(slugFromName('日本')).toBe('company');
    expect(slugFromName('A!')).toBe('company-a');
  });

  it('stays within 40 characters and never ends in a hyphen', () => {
    const slug = slugFromName(`${'a'.repeat(39)} b`);

    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).not.toMatch(/-$/);
  });

  it('adds a number without exceeding the limit', () => {
    expect(numberedSlug('acme', 2)).toBe('acme-2');
    expect(numberedSlug('a'.repeat(40), 12)).toBe(`${'a'.repeat(37)}-12`);
  });

  it('only ever produces names that the database and Git tools accept', () => {
    const pattern = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
    for (const name of ['Acme', 'x y', 'Ünïcödé Inc.', '123', `${'long '.repeat(20)}name`, '日本', 'A!']) {
      expect(slugFromName(name)).toMatch(pattern);
      expect(numberedSlug(slugFromName(name), 99)).toMatch(pattern);
    }
  });
});
