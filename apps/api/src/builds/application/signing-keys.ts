import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { PublicSigningKey } from '@dreamdevops/contracts/builds/http';
import type { ImageSigningKeys } from '@dreamdevops/contracts/builds/services';
import { currentCompanyId } from '@dreamdevops/shared-kernel';
import type { TenantDatabase, TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { SigningPurpose } from '../domain/build.ts';

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
  async privateKey(tx: TenantTransaction, purpose: SigningPurpose): Promise<string> {
    const { rows } = await tx.query<{ private_key: string }>(
      'SELECT private_key FROM builds.signing_keys WHERE purpose = $1',
      [purpose],
    );
    if (rows[0] !== undefined) {
      return this.#decrypt(rows[0].private_key);
    }
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const { rows: inserted } = await tx.query<{ private_key: string }>(
      `INSERT INTO builds.signing_keys (company_id, purpose, public_key, private_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, purpose) DO NOTHING
       RETURNING private_key`,
      [currentCompanyId(), purpose, publicKey, this.#encrypt(privateKey)],
    );
    if (inserted[0] !== undefined) {
      return privateKey;
    }
    // Another build made it at the same moment, so its key is used.
    return this.privateKey(tx, purpose);
  }

  /** One public key, made with its private key if missing. Call inside the company's transaction. */
  async publicKey(tx: TenantTransaction, purpose: SigningPurpose): Promise<string> {
    await this.privateKey(tx, purpose);
    return (await this.publicKeys(tx)).find((key) => key.purpose === purpose)!.publicKey;
  }

  /** The company's public keys, which targets use to check images. */
  async publicKeys(tx: TenantTransaction): Promise<PublicKey[]> {
    const { rows } = await tx.query<{ purpose: SigningPurpose; public_key: string }>(
      'SELECT purpose, public_key FROM builds.signing_keys ORDER BY purpose',
    );
    return rows.map((row) => ({ purpose: row.purpose, publicKey: row.public_key }));
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
  readonly #database: TenantDatabase;
  readonly #keys: SigningKeys;

  constructor(database: TenantDatabase, keys: SigningKeys) {
    this.#database = database;
    this.#keys = keys;
  }

  publicKey(purpose: SigningPurpose): Promise<string> {
    return this.#database.transaction((tx) => this.#keys.publicKey(tx, purpose));
  }
}
