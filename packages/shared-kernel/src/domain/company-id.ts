declare const companyIdBrand: unique symbol;

/** Identifies the company that owns a piece of data. */
export type CompanyId = string & { readonly [companyIdBrand]: true };

import { isUuid } from './identifiers.ts';

export function parseCompanyId(value: string): CompanyId {
  if (!isUuid(value)) {
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
