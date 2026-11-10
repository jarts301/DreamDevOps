import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from 'node:crypto';

/**
 * Image signatures in cosign's format, so anyone can check them with
 * `cosign verify --key <public key>`. A signature covers a small JSON document naming
 * the image's digest, and lives in the registry beside the image, under a tag made
 * from that digest.
 */
export const SIGNATURE_MEDIA_TYPE = 'application/vnd.dev.cosign.simplesigning.v1+json';
export const SIGNATURE_ANNOTATION = 'dev.cosignproject.cosign/signature';
const SIGNATURE_TYPE = 'cosign container image signature';
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const SIGNING_ALGORITHM = 'ECDSA P-256 with SHA-256';

/** What gets signed: the image's repository, such as localhost:3000/acme/billing, and its digest. */
export function signaturePayload(repository: string, digest: string): Buffer {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error('A digest must be sha256:<64 hex characters>.');
  }
  return Buffer.from(
    JSON.stringify({
      critical: {
        identity: { 'docker-reference': repository },
        image: { 'docker-manifest-digest': digest },
        type: SIGNATURE_TYPE,
      },
      optional: null,
    }),
  );
}

/** Reads a payload back, or returns null if it isn't a cosign image signature. */
export function readPayload(payload: Buffer): { repository: string; digest: string } | null {
  try {
    const document = JSON.parse(payload.toString('utf8')) as {
      critical?: { identity?: { 'docker-reference'?: unknown }; image?: { 'docker-manifest-digest'?: unknown }; type?: unknown };
    };
    const repository = document.critical?.identity?.['docker-reference'];
    const digest = document.critical?.image?.['docker-manifest-digest'];
    if (document.critical?.type !== SIGNATURE_TYPE || typeof repository !== 'string' || typeof digest !== 'string') {
      return null;
    }
    return { repository, digest };
  } catch {
    return null;
  }
}

/** The tag cosign stores an image's signatures under: sha256:abc… becomes sha256-abc….sig. */
export function signatureTag(digest: string): string {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error('A digest must be sha256:<64 hex characters>.');
  }
  return `${digest.replace(':', '-')}.sig`;
}

export class InvalidSigningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSigningKeyError';
  }
}

/** The platform's private key for signing images. Only ECDSA P-256 keys are accepted. */
export class SigningKey {
  readonly #privateKey: KeyObject;
  readonly publicKey: KeyObject;

  private constructor(privateKey: KeyObject) {
    this.#privateKey = privateKey;
    this.publicKey = createPublicKey(privateKey);
  }

  static fromPem(pem: string): SigningKey {
    let key: KeyObject;
    try {
      key = createPrivateKey(pem);
    } catch {
      throw new InvalidSigningKeyError('The image signing key is not a readable, unencrypted PEM private key.');
    }
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new InvalidSigningKeyError('The image signing key must be an ECDSA P-256 key.');
    }
    return new SigningKey(key);
  }

  /** A new key, and its PEM text for saving. */
  static generate(): { key: SigningKey; pem: string } {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return { key: new SigningKey(privateKey), pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  }

  get publicKeyPem(): string {
    return this.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  /** Identifies the key, so people can tell which key signed an image. */
  get fingerprint(): string {
    return fingerprintOf(this.publicKey);
  }

  /** A DER-encoded ECDSA signature, in base64, as cosign stores it. */
  sign(payload: Buffer): string {
    return sign('sha256', payload, { key: this.#privateKey, dsaEncoding: 'der' }).toString('base64');
  }
}

export function fingerprintOf(publicKey: KeyObject): string {
  return `sha256:${createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
}

export function verifySignature(publicKey: KeyObject, payload: Buffer, signature: string): boolean {
  try {
    return verify('sha256', payload, { key: publicKey, dsaEncoding: 'der' }, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
