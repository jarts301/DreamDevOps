/**
 * Why a rule refused a request. Each kind means the same thing in every module, so an
 * API or any other caller can answer all of them one way.
 */
export type DomainErrorKind = 'invalid' | 'not-found' | 'conflict' | 'forbidden' | 'not-entitled' | 'unavailable';

/**
 * A rule of a module refused a request. The message is safe to show to the person who
 * asked. Each module has its own subclass, limited to the kinds it uses.
 */
export abstract class DomainError<TKind extends DomainErrorKind = DomainErrorKind> extends Error {
  readonly kind: TKind;

  constructor(kind: TKind, message: string) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
  }
}
