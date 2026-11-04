import { createHash, randomBytes } from 'node:crypto';

export const SESSION_STORE = Symbol('SESSION_STORE');

/** Who is signed in. Permissions are read on each request, so they're never stale. */
export interface SessionData {
  readonly userId: string;
  readonly chosenCompanyId: string | null;
  /** Kept only to end the login provider's session at logout. */
  readonly idToken: string | null;
}

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
