import { AsyncLocalStorage } from 'node:async_hooks';
import type { CompanyId } from '../domain/company-id.ts';

const storage = new AsyncLocalStorage<CompanyId>();

/**
 * Runs work on behalf of one company. Call this only with an identity the server
 * has established, such as from a verified session, never with a client-sent value.
 */
export function runWithCompany<T>(companyId: CompanyId, work: () => T): T {
  return storage.run(companyId, work);
}

/** Fails instead of returning nothing, so code can't silently run without a company. */
export function currentCompanyId(): CompanyId {
  const companyId = storage.getStore();
  if (companyId === undefined) {
    throw new MissingTenantContextError();
  }
  return companyId;
}

export class MissingTenantContextError extends Error {
  constructor() {
    super('This operation must run inside runWithCompany().');
    this.name = 'MissingTenantContextError';
  }
}
