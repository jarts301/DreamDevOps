import { createSign, createVerify } from 'node:crypto';

/** The media type Cosign gives a signature's payload layer. */
export const SIGNATURE_MEDIA_TYPE = 'application/vnd.dev.cosign.simplesigning.v1+json';
export const SIGNATURE_ANNOTATION = 'dev.cosignproject.cosign/signature';

/**
 * The payload Cosign signs: which image, by repository and manifest digest. The digest
 * means a changed tag can never pass as the signed image.
 */
export function signaturePayload(repository: string, digest: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      critical: {
        identity: { 'docker-reference': repository },
        image: { 'docker-manifest-digest': digest },
        type: 'cosign container image signature',
      },
      optional: null,
    }),
  );
}

/** An ECDSA P-256 signature over SHA-256, in base64 DER, as Cosign writes it. */
export function signPayload(privateKeyPem: string, payload: Buffer): string {
  return createSign('sha256').update(payload).sign(privateKeyPem, 'base64');
}

export function verifyPayload(publicKeyPem: string, payload: Buffer, signature: string): boolean {
  return createVerify('sha256').update(payload).verify(publicKeyPem, signature, 'base64');
}

/** The tag Cosign looks for a signature at: sha256-<hex>.sig. */
export function signatureTag(digest: string): string {
  return `${digest.replace(':', '-')}.sig`;
}
