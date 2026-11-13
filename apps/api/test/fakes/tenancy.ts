import {
  type GitOrganization,
  type GitProvider,
  PermanentProvisioningError,
} from '../../src/tenancy/application/ports.ts';

/** Records organizations in memory, and can be told to fail. */
export class FakeGitProvider implements GitProvider {
  readonly organizations = new Map<string, GitOrganization>();
  /** Errors to throw, one per call, before calls start succeeding. */
  readonly failures: Error[] = [];
  calls = 0;

  async ensureOrganization(organization: GitOrganization): Promise<string> {
    this.calls += 1;
    const failure = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    const existing = this.organizations.get(organization.name);
    if (existing !== undefined && existing.companyId !== organization.companyId) {
      throw new PermanentProvisioningError(`The Git organization name "${organization.name}" is already taken.`);
    }
    this.organizations.set(organization.name, organization);
    return `org-${organization.name}`;
  }
}
