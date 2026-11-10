import { createHash, createPublicKey, type KeyObject, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { EnvironmentError } from './errors.ts';

/** A registration token works once, within an hour, so it can sit in a command for a while. */
export const REGISTRATION_MINUTES = 60;
/** Access tokens are short, so a revoked target loses access within minutes. */
export const ACCESS_TOKEN_MINUTES = 15;
/** How often agents report in. */
export const HEARTBEAT_SECONDS = 30;
/** Signed assertions must be fresh, and can be used once. */
export const MAX_ASSERTION_SECONDS = 120;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TOKEN_PATTERN = new RegExp(`^(${UUID})\\.([A-Za-z0-9_-]{43})$`);
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Tokens name their target, so the platform can find its company without a session:
 * "<target id>.<secret>". Only a hash of the secret is stored.
 */
export function newToken(targetId: string): { token: string; hash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${targetId}.${secret}`, hash: hashSecret(secret) };
}

export function parseToken(value: unknown): { targetId: string; secret: string } | null {
  const match = typeof value === 'string' ? TOKEN_PATTERN.exec(value) : null;
  return match === null ? null : { targetId: match[1]!, secret: match[2]! };
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function secretMatches(secret: string, hash: string | null): boolean {
  return hash !== null && timingSafeEqual(Buffer.from(hashSecret(secret), 'hex'), Buffer.from(hash, 'hex'));
}

/** Reads an Ed25519 public key sent as a JWK. Returns its "x" value, which is all that is stored. */
export function parsePublicKey(value: unknown): string {
  const jwk = value as { kty?: unknown; crv?: unknown; x?: unknown; d?: unknown } | null;
  if (
    typeof jwk !== 'object' ||
    jwk === null ||
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string' ||
    !KEY_PATTERN.test(jwk.x)
  ) {
    throw new EnvironmentError('invalid', 'Send the public key as an Ed25519 JWK.');
  }
  if (jwk.d !== undefined) {
    throw new EnvironmentError('invalid', 'Send only the public key. The private key must stay in the target.');
  }
  publicKeyObject(jwk.x);
  return jwk.x;
}

function publicKeyObject(x: string): KeyObject {
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
  } catch {
    throw new EnvironmentError('invalid', 'Send the public key as an Ed25519 JWK.');
  }
}

/** A short, readable fingerprint of a key, for people to compare with the agent's log. */
export function keyFingerprint(x: string): string {
  const hash = createHash('sha256').update(Buffer.from(x, 'base64url')).digest('hex');
  return hash.slice(0, 16).match(/.{4}/g)!.join(':');
}

export interface Assertion {
  readonly targetId: string;
  readonly assertionId: string;
  readonly expiresAt: Date;
}

/** Reads the claims of a signed assertion without checking it, to find its target. */
export function assertionTarget(value: unknown): string | null {
  const parts = typeof value === 'string' ? value.split('.') : [];
  if (parts.length !== 3) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { iss?: unknown };
    return typeof claims.iss === 'string' && new RegExp(`^${UUID}$`).test(claims.iss) ? claims.iss : null;
  } catch {
    return null;
  }
}

/**
 * Checks an agent's signed assertion: a JWT (RFC 7523) the agent signs with its private
 * key, naming itself as issuer and subject and the token address as audience. It must
 * last at most two minutes, and its ID is used once.
 */
export function verifyAssertion(value: unknown, publicKey: string, audience: string, now = new Date()): Assertion {
  const refused = () => new EnvironmentError('unauthorized', 'This assertion is not valid.');
  const parts = typeof value === 'string' && value.length <= 2_000 ? value.split('.') : [];
  if (parts.length !== 3) {
    throw refused();
  }
  const [header, payload, signature] = parts as [string, string, string];
  let claims: { iss?: unknown; sub?: unknown; aud?: unknown; exp?: unknown; iat?: unknown; jti?: unknown };
  try {
    const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: unknown };
    if (parsedHeader.alg !== 'EdDSA') {
      throw refused();
    }
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof claims;
  } catch {
    throw refused();
  }
  const signed = verify(
    null,
    Buffer.from(`${header}.${payload}`),
    publicKeyObject(publicKey),
    Buffer.from(signature, 'base64url'),
  );
  const seconds = Math.floor(now.getTime() / 1000);
  if (
    !signed ||
    typeof claims.iss !== 'string' ||
    claims.sub !== claims.iss ||
    claims.aud !== audience ||
    typeof claims.exp !== 'number' ||
    typeof claims.iat !== 'number' ||
    typeof claims.jti !== 'string' ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(claims.jti) ||
    claims.exp <= seconds ||
    claims.iat > seconds + 30 ||
    claims.exp - claims.iat > MAX_ASSERTION_SECONDS
  ) {
    throw refused();
  }
  return { targetId: claims.iss, assertionId: claims.jti, expiresAt: new Date(claims.exp * 1000) };
}

/** What an agent reports about itself. Versions are short, printable labels. */
export function parseVersionLabel(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,39}$/.test(value)) {
    throw new EnvironmentError('invalid', 'Versions are up to 40 letters, digits, dots, plus signs, underscores and hyphens.');
  }
  return value;
}
