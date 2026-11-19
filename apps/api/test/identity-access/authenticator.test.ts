import { describe, expect, it } from 'vitest';
import { Authenticator } from '../../src/identity-access/application/authenticator.ts';
import { hashSessionId } from '../../src/identity-access/application/sessions.ts';
import { COMPANY_A, InMemoryUserDirectory } from '../fakes.ts';
import { InMemorySessionStore } from '../in-memory-session-store.ts';

const LIFETIME = { absoluteMs: 3_600_000, idleMs: 600_000 };

/** A directory with one person in it, signed in as the fake login provider would sign them in. */
async function setUp(name: string) {
  const directory = new InMemoryUserDirectory();
  const userId = await directory.recordLogin({
    subject: `fake|${name}`,
    email: `${name}@example.com`,
    emailVerified: true,
    displayName: name,
    platformAdmin: false,
    idToken: null,
    mfa: true,
  });
  const sessions = new InMemorySessionStore();
  return { directory, sessions, userId, authenticator: new Authenticator(sessions, directory, { idleMs: LIFETIME.idleMs }) };
}

describe('the authenticator', () => {
  it('finds who a session belongs to, with what they may do in the company they chose', async () => {
    const { sessions, userId, authenticator } = await setUp('developer-a');
    await sessions.create(hashSessionId('the-session'), { userId, chosenCompanyId: COMPANY_A, idToken: 'token', mfa: true }, LIFETIME);

    const signedIn = await authenticator.authenticate('the-session');

    expect(signedIn).toMatchObject({
      principal: { userId, companyId: COMPANY_A, role: 'developer', permissions: ['applications:read'] },
      session: { userId, idToken: 'token' },
      sessionIdHash: hashSessionId('the-session'),
    });
  });

  it('knows no one for an unknown session, or one whose person is gone', async () => {
    const { sessions, authenticator } = await setUp('developer-a');
    await sessions.create(hashSessionId('orphan'), { userId: crypto.randomUUID(), chosenCompanyId: null, idToken: null, mfa: true }, LIFETIME);

    await expect(authenticator.authenticate('unknown')).resolves.toBeNull();
    await expect(authenticator.authenticate('orphan')).resolves.toBeNull();
  });

  it('counts someone who needs a second factor, but signed in without one, as signed out', async () => {
    const { sessions, userId, authenticator } = await setUp('tech-lead-a');
    await sessions.create(hashSessionId('no-second-factor'), { userId, chosenCompanyId: COMPANY_A, idToken: null }, LIFETIME);
    await sessions.create(hashSessionId('second-factor'), { userId, chosenCompanyId: COMPANY_A, idToken: null, mfa: true }, LIFETIME);

    await expect(authenticator.authenticate('no-second-factor')).resolves.toBeNull();
    await expect(authenticator.authenticate('second-factor')).resolves.toMatchObject({ principal: { role: 'tech-lead' } });
  });
});
