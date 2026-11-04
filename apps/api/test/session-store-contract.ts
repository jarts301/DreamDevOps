import { describe, expect, it } from 'vitest';
import { hashSessionId, newSessionId, type SessionData, type SessionStore } from '../src/session/session-store.ts';

const data: SessionData = {
  userId: '00000000-0000-4000-8000-000000000001',
  chosenCompanyId: null,
  idToken: 'id-token',
};

const LONG = { absoluteMs: 60_000, idleMs: 60_000 };
const newHash = () => hashSessionId(newSessionId());

export interface SessionStoreHarness {
  readonly store: SessionStore;
  /** Moves a limit into the past, instead of waiting for it. */
  expire(idHash: string, limit: 'idle' | 'absolute'): Promise<void>;
  /** The session's limits, in milliseconds since the epoch. */
  expiryTimes(idHash: string): Promise<{ idle: number; absolute: number }>;
}

/**
 * Every SessionStore must pass these, so the fake can't drift from PostgreSQL. None of
 * them wait on a clock, because Docker Desktop's VM clock has been measured stepping
 * backwards by seconds under load, which made waiting tests fail at random.
 */
export function describeSessionStoreContract(name: string, getHarness: () => SessionStoreHarness): void {
  describe(`SessionStore contract: ${name}`, () => {
    const getStore = () => getHarness().store;

    it('returns the data of a live session', async () => {
      const hash = newHash();
      await getStore().create(hash, data, LONG);

      await expect(getStore().touch(hash, 60_000)).resolves.toEqual(data);
    });

    it('returns null for an unknown session', async () => {
      await expect(getStore().touch(newHash(), 60_000)).resolves.toBeNull();
    });

    it('saves changed data', async () => {
      const hash = newHash();
      await getStore().create(hash, data, LONG);
      const changed = { ...data, chosenCompanyId: '00000000-0000-4000-8000-00000000000a' };

      await getStore().update(hash, changed);

      await expect(getStore().touch(hash, 60_000)).resolves.toEqual(changed);
    });

    it('ends a deleted session', async () => {
      const hash = newHash();
      await getStore().create(hash, data, LONG);

      await getStore().delete(hash);

      await expect(getStore().touch(hash, 60_000)).resolves.toBeNull();
    });

    it('ignores deleting an unknown session', async () => {
      await expect(getStore().delete(newHash())).resolves.toBeUndefined();
    });

    it('ends a session left idle', async () => {
      const hash = newHash();
      await getStore().create(hash, data, LONG);

      await getHarness().expire(hash, 'idle');

      await expect(getStore().touch(hash, 60_000)).resolves.toBeNull();
    });

    it('ends a session at its absolute limit, even if it is not idle', async () => {
      const hash = newHash();
      await getStore().create(hash, data, LONG);

      await getHarness().expire(hash, 'absolute');

      await expect(getStore().touch(hash, 60_000)).resolves.toBeNull();
    });

    it('sets its limits from the requested lifetime', async () => {
      const hash = newHash();
      await getStore().create(hash, data, { absoluteMs: 3_600_000, idleMs: 60_000 });

      const { idle, absolute } = await getHarness().expiryTimes(hash);

      expect(absolute - idle).toBe(3_540_000);
    });

    it('extends the idle limit while the session is used', async () => {
      const hash = newHash();
      await getStore().create(hash, data, { absoluteMs: 86_400_000, idleMs: 1_000 });
      const before = await getHarness().expiryTimes(hash);

      await expect(getStore().touch(hash, 3_600_000)).resolves.toEqual(data);

      const after = await getHarness().expiryTimes(hash);
      expect(after.idle - before.idle).toBeGreaterThan(3_000_000);
      expect(after.absolute).toBe(before.absolute);
    });

    it('never extends a session past its absolute limit', async () => {
      const hash = newHash();
      await getStore().create(hash, data, { absoluteMs: 60_000, idleMs: 1_000 });

      await getStore().touch(hash, 86_400_000);

      const { idle, absolute } = await getHarness().expiryTimes(hash);
      expect(idle).toBe(absolute);
    });
  });
}
