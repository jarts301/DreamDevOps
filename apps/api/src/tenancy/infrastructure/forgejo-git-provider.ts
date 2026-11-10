import { expectOk as expectForgejoOk, ForgejoApi, type ForgejoConnection, segment } from '../../shared/forgejo/forgejo-api.ts';
import { type GitOrganization, type GitProvider, PermanentProvisioningError } from '../application/ports.ts';

export type ForgejoOptions = ForgejoConnection;

interface ForgejoOrganization {
  id: number;
  full_name: string;
  description: string;
  visibility: string;
}

/**
 * The Forgejo adapter. Each company gets a private organization, owned by the platform
 * bot. Its description records the company ID, which proves an existing organization is
 * ours before anything changes it.
 */
export class ForgejoGitProvider implements GitProvider {
  readonly #api: ForgejoApi;

  constructor(options: ForgejoOptions) {
    this.#api = new ForgejoApi(options, { defaultTimeoutMs: 10_000 });
  }

  async ensureOrganization(organization: GitOrganization): Promise<string> {
    const marker = ownershipMarker(organization.companyId);
    const existing = await this.#api.request('GET', `/orgs/${segment(organization.name)}`);

    if (existing.status === 404) {
      const created = await this.#api.request('POST', '/orgs', {
        username: organization.name,
        full_name: organization.displayName,
        description: marker,
        visibility: 'private',
        repo_admin_change_team_access: false,
      });
      if (created.status === 422 || created.status === 409) {
        throw new PermanentProvisioningError(`The Git organization name "${organization.name}" is already taken.`);
      }
      await expectOk(created, 'create the Git organization');
      return String(((await created.json()) as ForgejoOrganization).id);
    }

    await expectOk(existing, 'read the Git organization');
    const current = (await existing.json()) as ForgejoOrganization;
    if (current.description !== marker) {
      throw new PermanentProvisioningError(
        `A Git organization named "${organization.name}" exists but belongs to someone else.`,
      );
    }
    if (current.full_name !== organization.displayName || current.visibility !== 'private') {
      const updated = await this.#api.request('PATCH', `/orgs/${segment(organization.name)}`, {
        full_name: organization.displayName,
        visibility: 'private',
      });
      await expectOk(updated, 'update the Git organization');
    }
    return String(current.id);
  }
}

export function ownershipMarker(companyId: string): string {
  return `Managed by DreamDevOps for company ${companyId}. Do not edit this description.`;
}

function expectOk(response: Response, action: string): Promise<void> {
  return expectForgejoOk(response, action, PermanentProvisioningError);
}
