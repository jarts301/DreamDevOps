import { DomainError } from '@dreamdevops/shared-kernel';

export type AlertErrorKind = 'invalid' | 'not-found' | 'conflict';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class AlertError extends DomainError<AlertErrorKind> {}
