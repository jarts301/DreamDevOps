export type BuildErrorKind = 'invalid' | 'not-found' | 'conflict' | 'unauthorized' | 'too-large';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class BuildError extends Error {
  readonly kind: BuildErrorKind;

  constructor(kind: BuildErrorKind, message: string) {
    super(message);
    this.name = 'BuildError';
    this.kind = kind;
  }
}
