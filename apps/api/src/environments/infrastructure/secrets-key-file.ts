import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { InvalidSecretsKeyError, SecretBox } from '../domain/secret-box.ts';

/**
 * Reads the key that seals environments' secrets. On a developer's machine, a missing key
 * is created, so the local setup works without extra steps. Elsewhere, it must already
 * exist: secrets sealed with a key nobody kept can never be read again.
 */
export function loadSecretsKey(path: string, options: { readonly createIfMissing: boolean }): SecretBox {
  if (!existsSync(path)) {
    if (!options.createIfMissing) {
      throw new InvalidSecretsKeyError(`The secrets key ${path} doesn't exist. Set SECRETS_KEY_FILE.`);
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      // "wx" fails if another process created the key first, so one key never replaces another.
      writeFileSync(path, SecretBox.generateKeyText(), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }
  return SecretBox.fromKeyText(readFileSync(path, 'utf8'));
}
