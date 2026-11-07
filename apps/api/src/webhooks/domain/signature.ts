import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Each repository's webhook secret, derived from one key and the application ID. Nothing
 * is stored, and changing the key and reapplying the hooks replaces every secret.
 */
export function webhookSecret(key: string, applicationId: string): string {
  return createHmac('sha256', key).update(`webhook:${applicationId}`).digest('hex');
}

/** Checks Forgejo's signature: an HMAC-SHA256 of the raw body, in hex. */
export function isValidSignature(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (signature === undefined || !/^[0-9a-f]{64}$/i.test(signature)) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
