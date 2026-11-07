import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDomainEvent, parseCompanyId } from '@dreamdevops/shared-kernel';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  entryHash,
  GENESIS_HASH,
  type StoredEntry,
  verifyChain,
} from '../src/audit/domain/hash-chain.ts';
import { InvitationEmails } from '../src/notifications/application/invitation-emails.ts';
import { NotificationRules } from '../src/notifications/application/notification-rules.ts';
import { RefusedWebhookError } from '../src/notifications/application/ports.ts';
import { NOTIFIABLE_EVENTS, summarize } from '../src/notifications/domain/event-catalog.ts';
import { NotificationError } from '../src/notifications/domain/errors.ts';
import { isBlockedAddress, SafeWebhookSender } from '../src/notifications/infrastructure/safe-webhook-sender.ts';
import { FakeMailer } from './fakes.ts';

const COMPANY = '00000000-0000-4000-8000-00000000000a';

const chain = (payloads: object[]): StoredEntry[] => {
  let previousHash = GENESIS_HASH;
  return payloads.map((payload, index) => {
    const entry = {
      companyId: COMPANY,
      sequence: index + 1,
      eventId: `event-${index}`,
      eventType: 'RoleGranted',
      eventVersion: 1,
      actorId: 'user-1',
      occurredAt: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
      payload,
    };
    const hash = entryHash(previousHash, entry);
    const stored = { ...entry, previousHash, hash };
    previousHash = hash;
    return stored;
  });
};

describe('the audit hash chain', () => {
  it('writes the same content the same way, whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { e: 1, f: 2 }] }, b: 1 }),
    );
  });

  it('accepts an untouched chain', () => {
    expect(verifyChain(chain([{ role: 'viewer' }, { role: 'developer' }, {}]))).toEqual({
      valid: true,
      checked: 3,
      brokenAtSequence: null,
      reason: null,
    });
  });

  it('accepts an empty history', () => {
    expect(verifyChain([]).valid).toBe(true);
  });

  it('finds a changed entry', () => {
    const entries = chain([{ role: 'viewer' }, { role: 'developer' }, {}]);
    entries[1] = { ...entries[1]!, payload: { role: 'company-admin' } };

    expect(verifyChain(entries)).toMatchObject({ valid: false, brokenAtSequence: 2, checked: 1 });
  });

  it('finds a changed actor or time, not only payloads', () => {
    const entries = chain([{}, {}]);

    expect(verifyChain([entries[0]!, { ...entries[1]!, actorId: 'someone-else' }]).valid).toBe(false);
    expect(verifyChain([{ ...entries[0]!, occurredAt: '2020-01-01T00:00:00.000Z' }, entries[1]!]).valid).toBe(false);
  });

  it('finds a removed entry', () => {
    const entries = chain([{}, {}, {}]);

    expect(verifyChain([entries[0]!, entries[2]!])).toMatchObject({ valid: false, brokenAtSequence: 3 });
  });

  it('finds an entry whose hash was recomputed to hide a change', () => {
    const entries = chain([{}, {}, {}]);
    const forged = { ...entries[1]!, payload: { forged: true } };
    const rehashed = { ...forged, hash: entryHash(forged.previousHash, forged) };

    expect(verifyChain([entries[0]!, rehashed, entries[2]!])).toMatchObject({ valid: false, brokenAtSequence: 3 });
  });
});

describe('notification messages', () => {
  const event = (eventType: string, payload: object) =>
    createDomainEvent({ eventType, companyId: parseCompanyId(COMPANY), payload });

  it('describes every notifiable event without falling back', () => {
    for (const type of Object.keys(NOTIFIABLE_EVENTS)) {
      expect(summarize(event(type, { role: 'developer', previousName: 'Old' }), 'Acme')).not.toContain('happened');
    }
  });

  it('names roles and the company', () => {
    expect(summarize(event('RoleGranted', { role: 'tech-lead', invitationId: 'i' }), 'Acme')).toBe(
      'Acme: Someone joined as Tech Lead.',
    );
    expect(summarize(event('RoleGranted', { role: 'viewer' }), 'Acme')).toBe("Acme: A member's role changed to Viewer.");
  });
});

describe('invitation emails', () => {
  const invitation = { id: 'i-1', token: 'secret token', expiresAt: '2026-11-13T10:00:00.000Z', email: 'x', role: 'viewer' };

  it('links to the dashboard with the token in the fragment', async () => {
    const mailer = new FakeMailer();
    const emails = new InvitationEmails(mailer, 'http://localhost:4200/');

    await expect(
      emails.send({ to: 'new@example.com', companyName: 'Acme', role: 'tech-lead', invitedBy: 'Ana', invitation }),
    ).resolves.toBe(true);

    const [sent] = mailer.sent;
    expect(sent?.to).toBe('new@example.com');
    expect(sent?.subject).toBe("You're invited to join Acme on DreamDevOps");
    expect(sent?.text).toContain('Ana invited you to join Acme on DreamDevOps as Tech Lead.');
    expect(sent?.text).toContain('http://localhost:4200/invitations/accept#token=secret%20token');
  });

  it('reports a failure instead of throwing', async () => {
    const mailer = new FakeMailer();
    mailer.failing = true;

    await expect(
      new InvitationEmails(mailer, 'http://localhost:4200').send({
        to: 'x@example.com',
        companyName: 'Acme',
        role: 'viewer',
        invitedBy: 'Ana',
        invitation,
      }),
    ).resolves.toBe(false);
  });
});

describe('webhook addresses', () => {
  const rules = (allowInsecureWebhooks: boolean) =>
    new NotificationRules({} as never, { post: async () => {} }, { allowInsecureWebhooks });
  const actor = { userId: 'u' } as never;
  const valid = { name: 'Team chat', kind: 'slack', url: 'https://hooks.example.com/abc', eventTypes: ['MemberRemoved'] };

  it.each([
    ['http://hooks.example.com/abc', 'plain http'],
    ['https://user:secret@hooks.example.com/abc', 'a password'],
    ['ftp://hooks.example.com', 'another scheme'],
    ['not a url', 'text'],
  ])('refuses %s (%s)', (url) => {
    expect(() => rules(false).create(actor, { ...valid, url })).toThrow(NotificationError);
  });

  it('allows plain http only when local testing allows it', () => {
    expect(() => rules(true).create(actor, { ...valid, url: 'ftp://x' })).toThrow(NotificationError);
    expect(() => rules(true).create(actor, { ...valid, url: 'http://localhost:9999/hook' })).not.toThrow(
      NotificationError,
    );
  });

  it.each([
    [{ eventTypes: [] }],
    [{ eventTypes: ['MadeUpEvent'] }],
    [{ kind: 'teams' }],
    [{ name: 'x' }],
  ])('refuses %j', (change) => {
    expect(() => rules(false).create(actor, { ...valid, ...change })).toThrow(NotificationError);
  });
});

describe('the webhook sender', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows the public address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each([
    'http://127.0.0.1:9/hook',
    'http://[::1]:9/hook',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost:9/hook',
  ])('refuses to send to %s', async (url) => {
    await expect(new SafeWebhookSender({ allowPrivateNetworks: false }).post(url, {})).rejects.toBeInstanceOf(
      RefusedWebhookError,
    );
  });

  it('sends JSON, and treats an error status as a failure', async () => {
    const received: string[] = [];
    let status = 200;
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        received.push(`${request.headers['content-type']} ${body}`);
        response.writeHead(status).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    const sender = new SafeWebhookSender({ allowPrivateNetworks: true });
    try {
      await sender.post(url, { text: 'hello' });
      status = 500;
      await expect(sender.post(url, { text: 'again' })).rejects.toThrow('status 500');

      expect(received).toEqual(['application/json {"text":"hello"}', 'application/json {"text":"again"}']);
    } finally {
      server.close();
    }
  });

  it('does not follow redirects', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, { Location: 'http://169.254.169.254/' }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    try {
      await expect(new SafeWebhookSender({ allowPrivateNetworks: true }).post(url, {})).rejects.toThrow('status 302');
    } finally {
      server.close();
    }
  });
});
