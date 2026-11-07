export type ReleaseErrorKind = 'invalid' | 'not-found' | 'conflict';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class ReleaseError extends Error {
  readonly kind: ReleaseErrorKind;

  constructor(kind: ReleaseErrorKind, message: string) {
    super(message);
    this.name = 'ReleaseError';
    this.kind = kind;
  }
}
