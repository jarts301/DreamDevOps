declare const companyIdBrand: unique symbol;

/** Identifies the company that owns a piece of data. */
export type CompanyId = string & { readonly [companyIdBrand]: true };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCompanyId(value: string): CompanyId {
  if (!UUID_PATTERN.test(value)) {
    throw new InvalidCompanyIdError();
  }
  return value.toLowerCase() as CompanyId;
}

export class InvalidCompanyIdError extends Error {
  constructor() {
    super('A company ID must be a UUID.');
    this.name = 'InvalidCompanyIdError';
  }
}
