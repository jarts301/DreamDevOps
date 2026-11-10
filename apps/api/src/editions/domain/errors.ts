import { DomainError } from '@dreamdevops/shared-kernel';

export type EditionErrorKind = 'invalid' | 'not-found' | 'conflict' | 'not-entitled';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class EditionError extends DomainError<EditionErrorKind> {}
