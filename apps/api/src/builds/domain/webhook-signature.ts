import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Each repository's webhook gets its own secret, made from one master secret and the
 * repository's name. Nothing needs storing, and a secret read from one repository's
 * settings can't sign events for another.
 */
export function webhookSecret(masterSecret: string, organization: string, name: string): string {
  return createHmac('sha256', masterSecret).update(`forgejo-webhook:${organization}/${name}`).digest('hex');
}

/** Forgejo signs each delivery's exact body with HMAC-SHA256, in hex. */
export function isValidWebhookSignature(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (signature === undefined || !/^[0-9a-f]{64}$/i.test(signature)) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
