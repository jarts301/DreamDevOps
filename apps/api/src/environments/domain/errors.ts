export type EnvironmentErrorKind = 'invalid' | 'unauthorized' | 'not-found' | 'conflict';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class EnvironmentError extends Error {
  readonly kind: EnvironmentErrorKind;

  constructor(kind: EnvironmentErrorKind, message: string) {
    super(message);
    this.name = 'EnvironmentError';
    this.kind = kind;
  }
}
