import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { InvalidSigningKeyError, SigningKey } from '../domain/signature.ts';

/**
 * Reads the image signing key. On a developer's machine, a missing key is created, so
 * the local setup works without extra steps. Elsewhere, the key must already exist,
 * because images signed with a key nobody kept can never be trusted again.
 */
export function loadSigningKey(path: string, options: { readonly createIfMissing: boolean }): SigningKey {
  if (!existsSync(path)) {
    if (!options.createIfMissing) {
      throw new InvalidSigningKeyError(`The image signing key ${path} doesn't exist. Set IMAGE_SIGNING_KEY_FILE.`);
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const { key, pem } = SigningKey.generate();
    try {
      // "wx" fails if another process created the key first, so one key never replaces another.
      writeFileSync(path, pem, { mode: 0o600, flag: 'wx' });
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }
  return SigningKey.fromPem(readFileSync(path, 'utf8'));
}
