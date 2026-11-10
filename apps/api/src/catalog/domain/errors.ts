import { DomainError } from '@dreamdevops/shared-kernel';

export type CatalogErrorKind = 'invalid' | 'not-found' | 'conflict';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class CatalogError extends DomainError<CatalogErrorKind> {}
