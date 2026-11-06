export type TenancyErrorKind = 'invalid' | 'not-found' | 'conflict';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class TenancyError extends Error {
  readonly kind: TenancyErrorKind;

  constructor(kind: TenancyErrorKind, message: string) {
    super(message);
    this.name = 'TenancyError';
    this.kind = kind;
  }
}
