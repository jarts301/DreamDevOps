import type { CurrentUser } from './http.ts';

/** Identity and access's published language: who is acting, and what they may do. */

/** The signed-in user for one request, acting for at most one company. */
export interface Principal extends CurrentUser {
  readonly emailVerified: boolean;
}

/**
 * Permissions are written as "subject:action", such as "releases:start", and each one
 * grants exactly what it names. None stands for others: "alerts:manage" doesn't include a
 * future "alerts:read", which has to be granted on its own.
 */
export function hasPermissions(principal: Pick<Principal, 'permissions'>, required: readonly string[]): boolean {
  const granted = new Set(principal.permissions);
  return required.every((permission) => granted.has(permission));
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An email address as Identity and access keeps it, trimmed and in lowercase, or null when it isn't one. */
export function normalizedEmail(value: unknown): string | null {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}
