import { DomainError } from '@dreamdevops/shared-kernel';

export type EnvironmentErrorKind = 'invalid' | 'unauthorized' | 'forbidden' | 'not-found' | 'conflict';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class EnvironmentError extends DomainError<EnvironmentErrorKind> {}
