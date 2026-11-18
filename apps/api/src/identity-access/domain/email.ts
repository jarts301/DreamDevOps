import { normalizedEmail } from '@dreamdevops/contracts/identity-access/access';
import { AccessError } from './errors.ts';

/** An email address as this context keeps it, or a refusal people can read. The rule itself is published in its contracts. */
export function normalizeEmail(value: unknown): string {
  const email = normalizedEmail(value);
  if (email === null) {
    throw new AccessError('invalid', 'Enter a valid email address.');
  }
  return email;
}
