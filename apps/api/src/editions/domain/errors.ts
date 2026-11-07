export type EditionErrorKind = 'invalid' | 'not-found' | 'conflict' | 'not-entitled';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class EditionError extends Error {
  readonly kind: EditionErrorKind;

  constructor(kind: EditionErrorKind, message: string) {
    super(message);
    this.name = 'EditionError';
    this.kind = kind;
  }
}
