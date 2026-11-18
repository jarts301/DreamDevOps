import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { PublicSigningKey } from '@dreamdevops/contracts/builds/http';
import type { ImageSigningKeys } from '@dreamdevops/contracts/builds/services';
import type { SigningPurpose } from '../domain/build.ts';
import type { BuildsSession, BuildsStore } from './ports.ts';

/** A company's public signing key, which targets check images with. */
export type PublicKey = PublicSigningKey;

/**
 * Each company's Cosign keys. They're made the first time they're needed. Private keys
 * are encrypted with AES-256-GCM under a key from the platform's settings, so the
 * database alone can't sign anything.
 */
export class SigningKeys {
  readonly #key: Buffer;

  constructor(secret: string) {
    this.#key = createHash('sha256').update(`signing-keys:${secret}`).digest();
  }

  /** The private key for signing, made if missing. Call inside the company's transaction. */
  async privateKey(session: BuildsSession, purpose: SigningPurpose): Promise<string> {
    const stored = await session.signingKey(purpose);
    if (stored !== null) {
      return this.#decrypt(stored.encryptedPrivateKey);
    }
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    if (await session.addSigningKey({ purpose, publicKey, encryptedPrivateKey: this.#encrypt(privateKey) })) {
      return privateKey;
    }
    // Another build made it at the same moment, so its key is used.
    return this.privateKey(session, purpose);
  }

  /** One public key, made with its private key if missing. Call inside the company's transaction. */
  async publicKey(session: BuildsSession, purpose: SigningPurpose): Promise<string> {
    await this.privateKey(session, purpose);
    return (await this.publicKeys(session)).find((key) => key.purpose === purpose)!.publicKey;
  }

  /** The company's public keys, which targets use to check images. */
  publicKeys(session: BuildsSession): Promise<PublicKey[]> {
    return session.publicKeys();
  }

  #encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
  }

  #decrypt(stored: string): string {
    const [version, iv, tag, encrypted] = stored.split(':');
    if (version !== 'v1' || iv === undefined || tag === undefined || encrypted === undefined) {
      throw new Error('A signing key is stored in an unknown format.');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
  }
}

/**
 * The current company's public keys, for other contexts, such as Environments, which gives
 * targets the key to check images with. Each call reads in a transaction of its own, so
 * no other context's transaction ever reaches this context's tables.
 */
export class CompanySigningKeys implements ImageSigningKeys {
  readonly #store: BuildsStore;
  readonly #keys: SigningKeys;

  constructor(store: BuildsStore, keys: SigningKeys) {
    this.#store = store;
    this.#keys = keys;
  }

  publicKey(purpose: SigningPurpose): Promise<string> {
    return this.#store.transaction((session) => this.#keys.publicKey(session, purpose));
  }
}
