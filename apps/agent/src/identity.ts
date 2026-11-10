import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * The agent's identity: an Ed25519 key pair made inside the cluster. Only the public key
 * ever leaves it. The private key signs short assertions the platform swaps for access
 * tokens.
 */
export interface KeyPair {
  /** PKCS #8 PEM. Kept in a Secret in the agent's namespace. */
  readonly privateKey: string;
  /** The public key as a JWK, as the platform registers it. */
  readonly publicJwk: { readonly kty: 'OKP'; readonly crv: 'Ed25519'; readonly x: string };
}

export function newKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const { x } = publicKey.export({ format: 'jwk' }) as { x: string };
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x },
  };
}

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A signed assertion (RFC 7523) for the platform's token address. It lasts one minute and works once. */
export function signAssertion(targetId: string, privateKey: string, audience: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = encode({ alg: 'EdDSA', typ: 'JWT' });
  const payload = encode({
    iss: targetId,
    sub: targetId,
    aud: audience,
    iat: seconds,
    exp: seconds + 60,
    jti: randomBytes(18).toString('base64url'),
  });
  const signature = sign(null, Buffer.from(`${header}.${payload}`), createPrivateKey(privateKey)).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

/** An SSH key for Flux to read the environment repository. Only the public half is sent. */
export interface SshKeyPair {
  /** PKCS #8 PEM, which Flux reads. */
  readonly privateKey: string;
  /** In OpenSSH format: "ssh-ed25519 AAAA...". */
  readonly publicKey: string;
}

export function newSshKeyPair(): SshKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: openSshPublicKey(publicKey.export({ format: 'jwk' }) as { x: string }),
  };
}

/** The public half of a stored SSH key, in OpenSSH format. */
export function sshPublicKeyOf(privateKey: string): string {
  return openSshPublicKey(createPublicKey(createPrivateKey(privateKey)).export({ format: 'jwk' }) as { x: string });
}

function openSshPublicKey(jwk: { x: string }): string {
  const sshString = (value: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    return Buffer.concat([length, value]);
  };
  const blob = Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(Buffer.from(jwk.x, 'base64url'))]);
  return `ssh-ed25519 ${blob.toString('base64')}`;
}
