import { createHash, randomBytes } from 'node:crypto';
import type { SessionData } from '@dreamdevops/contracts/identity-access/services';

export type { SessionData } from '@dreamdevops/contracts/identity-access/services';

/** Login sessions are Identity and access's: it keeps them, and the platform asks it who is signed in. */
export const SESSION_STORE = Symbol('SESSION_STORE');

export interface SessionLifetime {
  readonly absoluteMs: number;
  readonly idleMs: number;
}

/** Keeps sessions by the hash of their ID, so a leaked store can't be used to sign in. */
export interface SessionStore {
  create(idHash: string, data: SessionData, lifetime: SessionLifetime): Promise<void>;
  /** Returns the session's data and extends its idle time, or null if it has expired. */
  touch(idHash: string, idleMs: number): Promise<SessionData | null>;
  update(idHash: string, data: SessionData): Promise<void>;
  delete(idHash: string): Promise<void>;
}

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}
