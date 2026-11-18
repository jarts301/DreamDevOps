import type { Request } from 'express';
import type { Principal } from '@dreamdevops/contracts/identity-access/access';
import type { SessionData } from '../session/session-store.ts';

export const SESSION_COOKIE = 'dd_session';
export const LOGIN_COOKIE = 'dd_login';

export interface ApiRequest extends Request {
  principal?: Principal;
  session?: SessionData;
  sessionIdHash?: string;
  cookies: Record<string, string | undefined>;
  /** The body exactly as received, kept for checking webhook signatures. */
  rawBody?: Buffer;
}
