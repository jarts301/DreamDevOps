import type { Request } from 'express';
import type { Principal } from '../identity-access/domain/access.ts';
import type { SessionData } from '../session/session-store.ts';

export const SESSION_COOKIE = 'dd_session';
export const LOGIN_COOKIE = 'dd_login';

export interface ApiRequest extends Request {
  principal?: Principal;
  session?: SessionData;
  sessionIdHash?: string;
  cookies: Record<string, string | undefined>;
}
