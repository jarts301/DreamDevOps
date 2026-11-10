import { type Check, failed, passed } from '../domain/pipeline.ts';
import { readPayload, type SigningKey, verifySignature } from '../domain/signature.ts';
import type { ImageRegistry } from './ports.ts';

export interface SignatureCheck {
  /** Whether a signature made with the platform's key covers this exact image. */
  readonly valid: boolean;
  readonly checks: readonly Check[];
}

/**
 * Reads an image's signatures back from the registry, and checks that one was made with
 * the platform's key for this repository and digest. Builds check it after signing, and
 * deployments again before anything runs.
 */
export async function checkSignature(
  registry: ImageRegistry,
  key: SigningKey,
  image: { readonly repository: string; readonly digest: string },
): Promise<SignatureCheck> {
  const signatures = await registry.signatures(image.repository, image.digest);
  const valid = signatures.filter((signature) => verifySignature(key.publicKey, signature.payload, signature.signature));
  const covering = valid.filter((signature) => {
    const claims = readPayload(signature.payload);
    return claims?.digest === image.digest && claims.repository === image.repository;
  });
  return {
    valid: covering.length > 0,
    checks: [
      signatures.length > 0
        ? passed('A signature is stored with the image')
        : failed('A signature is stored with the image', 'The registry has no signature for this image.'),
      valid.length > 0
        ? passed("It matches the platform's key", key.fingerprint)
        : failed("It matches the platform's key", "No stored signature was made with the platform's key."),
      covering.length > 0
        ? passed("It covers this image's digest", image.digest)
        : failed("It covers this image's digest", "No valid signature names this image's digest."),
    ],
  };
}
