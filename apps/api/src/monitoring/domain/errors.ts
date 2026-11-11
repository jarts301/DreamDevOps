import { DomainError } from '@dreamdevops/shared-kernel';

export type MonitoringErrorKind = 'invalid' | 'not-found' | 'unavailable';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class MonitoringError extends DomainError<MonitoringErrorKind> {}
