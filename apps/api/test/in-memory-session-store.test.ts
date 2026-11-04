import { InMemorySessionStore } from './in-memory-session-store.ts';
import { describeSessionStoreContract } from './session-store-contract.ts';

const store = new InMemorySessionStore();

describeSessionStoreContract('in-memory fake', () => ({
  store,
  expire: async (idHash, limit) => store.expire(idHash, limit),
  expiryTimes: async (idHash) => store.expiryTimes(idHash),
}));
