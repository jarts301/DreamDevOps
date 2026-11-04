import type { Request } from 'express';
import type { Principal } from '../identity/principal.ts';

export const SESSION_COOKIE = 'dd_session';
export const LOGIN_COOKIE = 'dd_login';

export interface ApiRequest extends Request {
  principal?: Principal;
  cookies: Record<string, string | undefined>;
}
