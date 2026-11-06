export const GIT_PROVIDER = Symbol('GIT_PROVIDER');

export interface GitOrganization {
  /** The organization's name in the Git tool, which is the company's slug. */
  readonly name: string;
  readonly displayName: string;
  readonly companyId: string;
}

/** The Git tool that holds each company's isolated group of repositories. */
export interface GitProvider {
  /**
   * Creates the organization, or brings an existing one up to date. Safe to repeat.
   * Returns the organization's ID in the Git tool.
   */
  ensureOrganization(organization: GitOrganization): Promise<string>;
}

/** Retrying can't help, such as when another owner already uses the name. */
export class PermanentProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentProvisioningError';
  }
}
