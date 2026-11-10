import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encrypts small values for the database with AES-256-GCM, under a key derived from a
 * platform setting and a purpose, so the database alone can't reveal them.
 */
export class SealedBox {
  readonly #key: Buffer;

  constructor(secret: string, purpose: string) {
    this.#key = createHash('sha256').update(`${purpose}:${secret}`).digest();
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
  }

  open(stored: string): string {
    const [version, iv, tag, encrypted] = stored.split(':');
    if (version !== 'v1' || iv === undefined || tag === undefined || encrypted === undefined) {
      throw new Error('A value is stored in an unknown format.');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
  }
}
