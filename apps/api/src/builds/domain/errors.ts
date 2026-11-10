import { DomainError } from '@dreamdevops/shared-kernel';

export type BuildErrorKind = 'invalid' | 'not-found' | 'conflict' | 'forbidden' | 'unavailable';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class BuildError extends DomainError<BuildErrorKind> {}
