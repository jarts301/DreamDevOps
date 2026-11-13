import { DomainError } from '@dreamdevops/shared-kernel';

export type NotificationErrorKind = 'invalid' | 'not-found' | 'conflict';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class NotificationError extends DomainError<NotificationErrorKind> {}
