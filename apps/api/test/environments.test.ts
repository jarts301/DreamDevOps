import { generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertionTarget,
  keyFingerprint,
  newToken,
  parsePublicKey,
  parseToken,
  parseVersionLabel,
  secretMatches,
  verifyAssertion,
} from '../src/environments/domain/agent-identity.ts';
import {
  acceptedImageKinds,
  acceptsFeatureImages,
  environmentSlug,
  normalizeEnvironmentName,
  parseKind,
} from '../src/environments/domain/environment.ts';

const TARGET = '7b0c8a52-3f7e-4f0e-9a51-0d7f3c1e2b4a';
const AUDIENCE = 'http://api.test/api/v1/agent/token';

/** An agent's key pair, as the agent would make it inside the target. */
const keyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { x: (publicKey.export({ format: 'jwk' }) as { x: string }).x, privateKey };
};

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Signs an assertion as the agent does. Claims can be changed to test refusals. */
export const signAssertion = (privateKey: KeyObject, claims: Record<string, unknown> = {}, alg = 'EdDSA') => {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg, typ: 'JWT' });
  const payload = encode({
    iss: TARGET,
    sub: TARGET,
    aud: AUDIENCE,
    iat: now,
    exp: now + 60,
    jti: randomBytes(16).toString('base64url'),
    ...claims,
  });
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
};

describe('environments', () => {
  it('have names of 2 to 40 characters and a fixed kind', () => {
    expect(normalizeEnvironmentName('  Team   A test ')).toBe('Team A test');
    expect(() => normalizeEnvironmentName('x')).toThrow('between 2 and 40');
    expect(() => normalizeEnvironmentName('a'.repeat(41))).toThrow('between 2 and 40');
    expect(parseKind('production')).toBe('production');
    expect(() => parseKind('staging')).toThrow('Choose test or production.');
    expect(environmentSlug('Team A test')).toBe('team-a-test');
    expect(environmentSlug('Team A test', 2)).toBe('team-a-test-2');
  });

  it('keep feature images out of production, and let test environments refuse them', () => {
    expect(acceptsFeatureImages('test', undefined)).toBe(true);
    expect(acceptsFeatureImages('test', false)).toBe(false);
    expect(acceptsFeatureImages('production', undefined)).toBe(false);
    expect(() => acceptsFeatureImages('production', true)).toThrow('Production accepts final images only.');
    expect(acceptedImageKinds({ kind: 'production', acceptsFeatureImages: false })).toEqual(['final']);
    expect(acceptedImageKinds({ kind: 'test', acceptsFeatureImages: false })).toEqual(['rc', 'final']);
    expect(acceptedImageKinds({ kind: 'test', acceptsFeatureImages: true })).toEqual(['feature', 'rc', 'final']);
  });
});

describe('agent identity', () => {
  it('names the target in each token, and keeps only a hash of the secret', () => {
    const { token, hash } = newToken(TARGET);
    const parsed = parseToken(token)!;

    expect(parsed.targetId).toBe(TARGET);
    expect(hash).not.toContain(parsed.secret);
    expect(secretMatches(parsed.secret, hash)).toBe(true);
    expect(secretMatches(parseToken(newToken(TARGET).token)!.secret, hash)).toBe(false);
    expect(parseToken('not-a-token')).toBeNull();
  });

  it('accepts only an Ed25519 public key', () => {
    const { x } = keyPair();
    const { privateKey } = keyPair();

    expect(parsePublicKey({ kty: 'OKP', crv: 'Ed25519', x })).toBe(x);
    expect(() => parsePublicKey({ ...(privateKey.export({ format: 'jwk' }) as object) })).toThrow(
      'The private key must stay in the target.',
    );
    expect(() => parsePublicKey({ kty: 'OKP', crv: 'X25519', x })).toThrow('Ed25519 JWK');
    expect(() => parsePublicKey('a key')).toThrow('Ed25519 JWK');
    expect(keyFingerprint(x)).toMatch(/^[0-9a-f]{4}(:[0-9a-f]{4}){3}$/);
  });

  it('accepts an assertion the agent signed for this address', () => {
    const { x, privateKey } = keyPair();
    const assertion = signAssertion(privateKey);

    expect(assertionTarget(assertion)).toBe(TARGET);
    expect(verifyAssertion(assertion, x, AUDIENCE)).toMatchObject({ targetId: TARGET });
  });

  it('refuses assertions that are forged, stale, too long or meant elsewhere', () => {
    const { x, privateKey } = keyPair();
    const other = keyPair();
    const now = Math.floor(Date.now() / 1000);
    const refused = 'This assertion is not valid.';

    expect(() => verifyAssertion(signAssertion(other.privateKey), x, AUDIENCE)).toThrow(refused);
    expect(() => verifyAssertion(signAssertion(privateKey, { exp: now - 1 }), x, AUDIENCE)).toThrow(refused);
    expect(() => verifyAssertion(signAssertion(privateKey, { exp: now + 600 }), x, AUDIENCE)).toThrow(refused);
    expect(() => verifyAssertion(signAssertion(privateKey, { aud: 'http://elsewhere' }), x, AUDIENCE)).toThrow(refused);
    expect(() => verifyAssertion(signAssertion(privateKey, { sub: 'someone-else' }), x, AUDIENCE)).toThrow(refused);
    expect(() => verifyAssertion(signAssertion(privateKey, { jti: 'short' }), x, AUDIENCE)).toThrow(refused);
    expect(() => verifyAssertion(signAssertion(privateKey, {}, 'none'), x, AUDIENCE)).toThrow(refused);

    const [header, , signature] = signAssertion(privateKey).split('.');
    const changed = encode({ iss: TARGET, sub: TARGET, aud: AUDIENCE, iat: now, exp: now + 60, jti: 'a'.repeat(20) });
    expect(() => verifyAssertion(`${header}.${changed}.${signature}`, x, AUDIENCE)).toThrow(refused);
    expect(() => verifyAssertion('a.b', x, AUDIENCE)).toThrow(refused);
  });

  it('accepts short version labels only', () => {
    expect(parseVersionLabel('v1.31.2+k3s1')).toBe('v1.31.2+k3s1');
    expect(parseVersionLabel(undefined)).toBeNull();
    expect(() => parseVersionLabel('1.0 <script>')).toThrow('Versions are up to 40');
  });
});
