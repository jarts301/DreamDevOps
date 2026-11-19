import { describe, expect, it } from 'vitest';
import { SignIn } from '../../src/identity-access/application/sign-in.ts';
import { hashSessionId } from '../../src/identity-access/application/sessions.ts';
import { FakeIdentityProvider, InMemoryUserDirectory } from '../fakes.ts';
import { InMemorySessionStore } from '../in-memory-session-store.ts';

/** Signing in, on its own, without HTTP: the controller only carries its cookies and redirects. */
const signIn = () => {
  const sessions = new InMemorySessionStore();
  const service = new SignIn(new FakeIdentityProvider(), new InMemoryUserDirectory(), sessions, {
    publicUrl: 'http://api.test',
    dashboardUrl: 'http://dashboard.test/',
    session: { absoluteMs: 600_000, idleMs: 60_000 },
  });
  return { service, sessions };
};

/** What the login provider sends the browser back with, to the callback. */
const callbackOf = (authorizationUrl: string) => {
  const url = new URL(authorizationUrl);
  return { state: url.searchParams.get('state'), callbackPath: `${url.pathname}${url.search}` };
};

describe('signing in', () => {
  it('starts a new session once the login provider answers for this login, and ends the one before', async () => {
    const { service, sessions } = signIn();
    await sessions.create(hashSessionId('old-session'), { userId: 'u', chosenCompanyId: null, idToken: null }, { absoluteMs: 60_000, idleMs: 60_000 });
    const { authorizationUrl, attempt } = await service.start('developer-a', undefined);

    const finished = await service.finish({ ...callbackOf(authorizationUrl), attempt, previousSessionId: 'old-session' });

    expect(finished).toEqual({ sessionId: expect.any(String) });
    expect(await sessions.touch(hashSessionId((finished as { sessionId: string }).sessionId), 60_000)).toMatchObject({
      chosenCompanyId: null,
      idToken: 'id-token-of-developer-a',
    });
    expect(await sessions.touch(hashSessionId('old-session'), 60_000)).toBeNull();
  });

  it("refuses an answer that isn't for this login, such as one with another state", async () => {
    const { service } = signIn();
    const { authorizationUrl, attempt } = await service.start('developer-a', undefined);
    const { callbackPath } = callbackOf(authorizationUrl);

    await expect(service.finish({ state: 'someone-elses', attempt, callbackPath, previousSessionId: undefined })).rejects.toMatchObject({
      kind: 'invalid',
    });
    await expect(service.finish({ state: 'x', attempt: undefined, callbackPath, previousSessionId: undefined })).rejects.toMatchObject({
      kind: 'invalid',
    });
  });

  it('starts again, asking for a second factor, when a role needs one and the login had none', async () => {
    const { service } = signIn();
    const { authorizationUrl, attempt } = await service.start('nomfa-tech-lead', undefined);

    const finished = await service.finish({ ...callbackOf(authorizationUrl), attempt, previousSessionId: undefined });

    expect(finished).toEqual({ stepUp: 'http://api.test/api/v1/auth/login?mfa=1&login_hint=nomfa-tech-lead%40example.com' });
  });

  it('refuses, rather than loop, when the second factor it asked for never comes', async () => {
    const { service } = signIn();
    const { authorizationUrl, attempt } = await service.start('nomfa-refuse-tech-lead', '1');

    await expect(service.finish({ ...callbackOf(authorizationUrl), attempt, previousSessionId: undefined })).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });
});

describe('a session', () => {
  it('acts only for a company the person belongs to', async () => {
    const { service, sessions } = signIn();
    const session = { idHash: hashSessionId('session'), data: { userId: 'u', chosenCompanyId: null, idToken: null } };
    await sessions.create(session.idHash, session.data, { absoluteMs: 60_000, idleMs: 60_000 });
    const principal = { memberships: [{ companyId: 'company-a', companyName: 'A', role: 'viewer' }] } as never;

    await expect(service.chooseCompany(principal, session, 'company-b')).rejects.toMatchObject({ kind: 'forbidden' });
    await service.chooseCompany(principal, session, 'company-a');

    expect(await sessions.touch(session.idHash, 60_000)).toMatchObject({ chosenCompanyId: 'company-a' });
  });

  it('ends at sign-out, with where to end the login provider’s session too', async () => {
    const { service, sessions } = signIn();
    await sessions.create(hashSessionId('session'), { userId: 'u', chosenCompanyId: null, idToken: 'token' }, { absoluteMs: 60_000, idleMs: 60_000 });

    const { logoutUrl } = await service.signOut(hashSessionId('session'), 'token');

    expect(logoutUrl).toBe(`http://login.test/logout?hint=token&next=${encodeURIComponent('http://dashboard.test/')}`);
    expect(await sessions.touch(hashSessionId('session'), 60_000)).toBeNull();
  });
});
