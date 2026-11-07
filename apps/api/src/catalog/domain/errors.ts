export type CatalogErrorKind = 'invalid' | 'not-found' | 'conflict';

/** A rule of this module refused the request. The message is safe to show to the user. */
export class CatalogError extends Error {
  readonly kind: CatalogErrorKind;

  constructor(kind: CatalogErrorKind, message: string) {
    super(message);
    this.name = 'CatalogError';
    this.kind = kind;
  }
}
