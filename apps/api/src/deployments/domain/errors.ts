export type DeploymentErrorKind = 'invalid' | 'forbidden' | 'not-found' | 'conflict' | 'not-entitled';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class DeploymentError extends Error {
  readonly kind: DeploymentErrorKind;

  constructor(kind: DeploymentErrorKind, message: string) {
    super(message);
    this.name = 'DeploymentError';
    this.kind = kind;
  }
}
