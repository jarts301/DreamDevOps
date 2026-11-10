import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newKeyPair, newSshKeyPair, signAssertion, sshPublicKeyOf } from '../src/identity.ts';

describe('the agent identity', () => {
  it('signs an assertion the platform can check with the public key alone', () => {
    const keys = newKeyPair();
    const assertion = signAssertion('target-1', keys.privateKey, 'http://api.test/api/v1/agent/token', 1_800_000_000_000);
    const [header, payload, signature] = assertion.split('.') as [string, string, string];

    const publicKey = createPublicKey({ key: keys.publicJwk, format: 'jwk' });
    expect(verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'EdDSA', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({
      iss: 'target-1',
      sub: 'target-1',
      aud: 'http://api.test/api/v1/agent/token',
      iat: 1_800_000_000,
      exp: 1_800_000_060,
      jti: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/),
    });
    expect(keys.publicJwk).not.toHaveProperty('d');
  });

  it('makes an SSH deploy key in OpenSSH format, and reads it back from the private key', () => {
    const keys = newSshKeyPair();

    expect(keys.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}=?$/);
    expect(keys.privateKey).toContain('BEGIN PRIVATE KEY');
    expect(sshPublicKeyOf(keys.privateKey)).toBe(keys.publicKey);
  });
});
