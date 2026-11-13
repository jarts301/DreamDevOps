import { DomainError } from '@dreamdevops/shared-kernel';

export type DeploymentErrorKind = 'invalid' | 'forbidden' | 'not-found' | 'conflict' | 'not-entitled';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class DeploymentError extends DomainError<DeploymentErrorKind> {}
