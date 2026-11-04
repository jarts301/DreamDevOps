import { describe, expect, it } from 'vitest';
import type { Principal } from '../src/identity/principal.ts';
import { hashSessionId, newSessionId, type SessionStore } from '../src/session/session-store.ts';

const principal: Principal = {
  subject: 'user-1',
  displayName: 'User One',
  companyId: '00000000-0000-4000-8000-00000000000a',
  permissions: ['applications:read'],
};

const LONG = { absoluteMs: 60_000, idleMs: 60_000 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const newHash = () => hashSessionId(newSessionId());

/** Every SessionStore must pass these, so the fake can't drift from PostgreSQL. */
export function describeSessionStoreContract(name: string, getStore: () => SessionStore): void {
  describe(`SessionStore contract: ${name}`, () => {
    it('returns the user of a live session', async () => {
      const hash = newHash();
      await getStore().create(hash, principal, LONG);

      await expect(getStore().touch(hash, 60_000)).resolves.toEqual(principal);
    });

    it('returns null for an unknown session', async () => {
      await expect(getStore().touch(newHash(), 60_000)).resolves.toBeNull();
    });

    it('ends a deleted session', async () => {
      const hash = newHash();
      await getStore().create(hash, principal, LONG);

      await getStore().delete(hash);

      await expect(getStore().touch(hash, 60_000)).resolves.toBeNull();
    });

    it('ignores deleting an unknown session', async () => {
      await expect(getStore().delete(newHash())).resolves.toBeUndefined();
    });

    it('ends a session left idle', async () => {
      const hash = newHash();
      await getStore().create(hash, principal, { absoluteMs: 60_000, idleMs: 100 });

      await sleep(200);

      await expect(getStore().touch(hash, 100)).resolves.toBeNull();
    });

    it('extends a session while it is used', async () => {
      const hash = newHash();
      await getStore().create(hash, principal, { absoluteMs: 60_000, idleMs: 400 });

      await sleep(250);
      await expect(getStore().touch(hash, 400)).resolves.toEqual(principal);
      await sleep(250);

      await expect(getStore().touch(hash, 400)).resolves.toEqual(principal);
    });

    it('ends a session at its absolute limit, even while it is used', async () => {
      const hash = newHash();
      await getStore().create(hash, principal, { absoluteMs: 300, idleMs: 60_000 });

      await expect(getStore().touch(hash, 60_000)).resolves.toEqual(principal);
      await sleep(400);

      await expect(getStore().touch(hash, 60_000)).resolves.toBeNull();
    });
  });
}
