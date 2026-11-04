import { InMemorySessionStore } from '../src/session/in-memory-session-store.ts';
import { describeSessionStoreContract } from './session-store-contract.ts';

const store = new InMemorySessionStore();

describeSessionStoreContract('in-memory fake', () => store);
