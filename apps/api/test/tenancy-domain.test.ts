import { describe, expect, it } from 'vitest';
import { TenancyError } from '../src/tenancy/domain/errors.ts';
import { nextApplicationStatus, nextCompanyStatus } from '../src/tenancy/domain/lifecycle.ts';
import {
  parseCompanySlug,
  parseDescription,
  parseName,
  parseSlug,
  slugFromName,
  slugOrFromName,
} from '../src/tenancy/domain/names.ts';

const refusal = (kind: string) => expect.objectContaining({ name: 'TenancyError', kind });

describe('names', () => {
  it('trims names and keeps their case', () => {
    expect(parseName('  Acme Corporation ', 'company')).toBe('Acme Corporation');
  });

  it.each([undefined, null, 42, '', '   ', 'x'.repeat(101), 'Acme\nCorp', 'Acme\u0000'])(
    'refuses the name %j',
    (name) => {
      expect(() => parseName(name, 'company')).toThrow(refusal('invalid'));
    },
  );

  it('allows names in any language', () => {
    expect(parseName('Café Société 株式会社', 'company')).toBe('Café Société 株式会社');
  });
});

describe('slugs', () => {
  it.each(['ab', 'acme', 'acme-corp', 'a1-b2-c3', 'x'.repeat(40)])('accepts %j', (slug) => {
    expect(parseSlug(slug)).toBe(slug);
  });

  it.each(['a', 'x'.repeat(41), 'Acme', 'acme corp', '-acme', 'acme-', 'ac--me', 'acme_corp', 'acme.corp', '', 42])(
    'refuses %j',
    (slug) => {
      expect(() => parseSlug(slug)).toThrow(refusal('invalid'));
    },
  );

  it.each(['admin', 'api', 'explore', 'user'])('keeps the Git hosting name %j from companies', (slug) => {
    expect(() => parseCompanySlug(slug)).toThrow(refusal('invalid'));
    // Applications live inside a company's organization, so these are fine for them.
    expect(parseSlug(slug)).toBe(slug);
  });

  it.each([
    ['Acme Corporation', 'acme-corporation'],
    ['  Café Société  ', 'cafe-societe'],
    ['ACME -- Corp!!', 'acme-corp'],
    ['Billing API v2', 'billing-api-v2'],
    ['株式会社', ''],
  ])('suggests a slug for %j', (name, slug) => {
    expect(slugFromName(name)).toBe(slug);
  });

  it('never suggests a slug that is too long or ends in a hyphen', () => {
    const slug = slugFromName(`${'a'.repeat(39)} tail`);

    expect(slug).toBe('a'.repeat(39));
    expect(parseSlug(slug)).toBe(slug);
  });

  it('uses the chosen slug over the name', () => {
    expect(slugOrFromName('acme', 'Something Else', parseSlug)).toBe('acme');
  });

  it.each([undefined, null, ''])('suggests a slug from the name when given %j', (slug) => {
    expect(slugOrFromName(slug, 'Acme Corp', parseSlug)).toBe('acme-corp');
  });

  it('asks for a slug when the name has too few letters or digits', () => {
    expect(() => slugOrFromName(undefined, '株式会社', parseSlug)).toThrow(/Choose a slug/);
  });

  it('still checks a slug made from the name', () => {
    expect(() => slugOrFromName(undefined, 'Admin', parseCompanySlug)).toThrow(/reserved/);
  });
});

describe('descriptions', () => {
  it.each([undefined, null])('treats %j as empty', (value) => {
    expect(parseDescription(value)).toBe('');
  });

  it('trims and normalizes line endings', () => {
    expect(parseDescription('  Bills customers.\r\nMonthly.  ')).toBe('Bills customers.\nMonthly.');
  });

  it.each([42, {}, 'x'.repeat(501)])('refuses %j', (value) => {
    expect(() => parseDescription(value)).toThrow(refusal('invalid'));
  });
});

describe('company lifecycle', () => {
  it.each([
    ['active', 'suspend', 'suspended'],
    ['suspended', 'reactivate', 'active'],
    ['provisioning', 'close', 'closed'],
    ['active', 'close', 'closed'],
    ['suspended', 'close', 'closed'],
    ['closed', 'erase', 'erased'],
  ] as const)('moves from %s by %s to %s', (from, action, to) => {
    expect(nextCompanyStatus(from, action)).toBe(to);
  });

  it.each([
    ['provisioning', 'suspend'],
    ['suspended', 'suspend'],
    ['closed', 'suspend'],
    ['provisioning', 'reactivate'],
    ['active', 'reactivate'],
    ['closed', 'reactivate'],
    ['closed', 'close'],
    ['provisioning', 'erase'],
    ['active', 'erase'],
    ['suspended', 'erase'],
    ['erased', 'erase'],
    ['erased', 'reactivate'],
    ['erased', 'close'],
  ] as const)('refuses to %2$s a company that is %1$s', (from, action) => {
    expect(() => nextCompanyStatus(from, action)).toThrow(refusal('conflict'));
  });

  it('explains refusals in words people can act on', () => {
    expect(() => nextCompanyStatus('closed', 'reactivate')).toThrow('Only a suspended company can be reactivated.');
    expect(() => nextCompanyStatus('active', 'erase')).toThrow('Close the company before erasing its data.');
    expect(() => nextCompanyStatus('erased', 'close')).toThrow("This company's data has been erased, so it can't change.");
  });
});

describe('application lifecycle', () => {
  it('archives and restores', () => {
    expect(nextApplicationStatus('active', 'archive')).toBe('archived');
    expect(nextApplicationStatus('archived', 'restore')).toBe('active');
  });

  it('refuses repeating either', () => {
    expect(() => nextApplicationStatus('archived', 'archive')).toThrow(TenancyError);
    expect(() => nextApplicationStatus('active', 'restore')).toThrow(TenancyError);
  });
});
