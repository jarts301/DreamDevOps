import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** A secret as it's stored: only this server's key can read it, and only in its own place. */
export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  /** Which key sealed it, so a secret sealed with another key is recognized as such. */
  readonly keyId: string;
}

/** Where a secret belongs. A sealed secret opens only there, so it can't be moved or swapped. */
export interface SecretPlace {
  readonly companyId: string;
  readonly environmentId: string;
  readonly name: string;
}

export class SecretUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretUnreadableError';
  }
}

export class InvalidSecretsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSecretsKeyError';
  }
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const ALGORITHM = 'aes-256-gcm';

/**
 * Seals and opens secrets with AES-256-GCM and this server's key. Each secret gets its
 * own random nonce, and its place is bound in as associated data, so a stored secret
 * copied into another environment, company or name doesn't open.
 */
export class SecretBox {
  readonly keyId: string;
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new InvalidSecretsKeyError(`The secrets key must be ${KEY_BYTES} bytes.`);
    }
    this.#key = Buffer.from(key);
    this.keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  /** A new random key, in the form the key file holds: base64. */
  static generateKeyText(): string {
    return `${randomBytes(KEY_BYTES).toString('base64')}\n`;
  }

  static fromKeyText(text: string): SecretBox {
    const key = Buffer.from(text.trim(), 'base64');
    if (key.length !== KEY_BYTES || key.toString('base64') !== text.trim()) {
      throw new InvalidSecretsKeyError(`The secrets key must be ${KEY_BYTES} bytes, written in base64.`);
    }
    return new SecretBox(key);
  }

  seal(value: string, place: SecretPlace): SealedSecret {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, nonce);
    cipher.setAAD(associatedData(place));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { ciphertext, nonce, tag: cipher.getAuthTag(), keyId: this.keyId };
  }

  open(sealed: SealedSecret, place: SecretPlace): string {
    if (sealed.keyId !== this.keyId) {
      throw new SecretUnreadableError(`${place.name} was sealed with another key than this server's. Set it again.`);
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, this.#key, sealed.nonce);
      decipher.setAAD(associatedData(place));
      decipher.setAuthTag(sealed.tag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretUnreadableError(`${place.name} can't be read: it was changed outside DreamDevOps. Set it again.`);
    }
  }
}

function associatedData(place: SecretPlace): Buffer {
  return Buffer.from(JSON.stringify(['dreamdevops-secret-v1', place.companyId, place.environmentId, place.name]), 'utf8');
}
