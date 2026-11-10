import { DomainError } from '@dreamdevops/shared-kernel';

export type SourceErrorKind = 'invalid' | 'not-found' | 'conflict';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class SourceError extends DomainError<SourceErrorKind> {}
