import { createDomainEvent, parseCompanyId } from '@dreamdevops/shared-kernel';
import { describe, expect, it } from 'vitest';
import { applicationSlug, normalizeApplicationName, normalizeDescription } from '../src/catalog/domain/application.ts';
import { summarize } from '../src/notifications/domain/event-catalog.ts';
import { COMPANY_A } from './fakes.ts';

describe('application names', () => {
  it('are trimmed and single-spaced', () => {
    expect(normalizeApplicationName('  Billing   API ')).toBe('Billing API');
  });

  it.each(['', 'a', 'x'.repeat(81), 'Bad\u0000name', 42, null])('refuses %j', (value) => {
    expect(() => normalizeApplicationName(value)).toThrow('Enter an application name between 2 and 80 characters.');
  });
});

describe('application descriptions', () => {
  it('are optional, trimmed, and keep line breaks', () => {
    expect(normalizeDescription(undefined)).toBe('');
    expect(normalizeDescription(null)).toBe('');
    expect(normalizeDescription('  First line\r\nSecond line  ')).toBe('First line\nSecond line');
  });

  it.each(['x'.repeat(501), 'Bell\u0007', 7])('refuses %j', (value) => {
    expect(() => normalizeDescription(value)).toThrow('Enter a description of at most 500 characters.');
  });
});

describe('application short names', () => {
  const pattern = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/;

  it('are made from the name, and fit the database rule', () => {
    expect(applicationSlug('Billing API')).toBe('billing-api');
    expect(applicationSlug('Café Órders')).toBe('cafe-orders');
    expect(applicationSlug('日本')).toBe('app');
    expect(applicationSlug('X!')).toBe('app-x');
    for (const name of ['Billing API', 'x'.repeat(80), `${'a'.repeat(59)} b`, '日本', '--a--']) {
      expect(applicationSlug(name)).toMatch(pattern);
      expect(applicationSlug(name, 99)).toMatch(pattern);
    }
  });

  it('are numbered when taken', () => {
    expect(applicationSlug('Billing API', 2)).toBe('billing-api-2');
    expect(applicationSlug('a'.repeat(80), 12)).toBe(`${'a'.repeat(57)}-12`);
  });
});

describe('application notifications', () => {
  const event = (eventType: string, payload: object) =>
    createDomainEvent({ eventType, companyId: parseCompanyId(COMPANY_A), payload });

  it('describe each change', () => {
    expect(summarize(event('ApplicationRegistered', { name: 'Billing' }), 'Acme')).toBe(
      'Acme: The application "Billing" was registered.',
    );
    expect(summarize(event('ApplicationUpdated', { name: 'Payments', previousName: 'Billing' }), 'Acme')).toBe(
      'Acme: The application "Billing" was renamed to "Payments".',
    );
    expect(summarize(event('ApplicationUpdated', { descriptionChanged: true }), 'Acme')).toBe(
      "Acme: An application's description changed.",
    );
    expect(summarize(event('ApplicationArchived', { name: 'Billing' }), 'Acme')).toBe(
      'Acme: The application "Billing" was archived.',
    );
    expect(summarize(event('ApplicationRestored', { name: 'Billing' }), 'Acme')).toBe(
      'Acme: The application "Billing" was restored.',
    );
  });
});
