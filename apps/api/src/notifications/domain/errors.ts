export type NotificationErrorKind = 'invalid' | 'not-found' | 'conflict';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class NotificationError extends Error {
  readonly kind: NotificationErrorKind;

  constructor(kind: NotificationErrorKind, message: string) {
    super(message);
    this.name = 'NotificationError';
    this.kind = kind;
  }
}
