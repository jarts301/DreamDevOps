import { DomainError } from '@dreamdevops/shared-kernel';

export type MonitoringErrorKind = 'invalid' | 'not-found' | 'unavailable' | 'too-large';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class MonitoringError extends DomainError<MonitoringErrorKind> {}
