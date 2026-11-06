import { type GitOrganization, type GitProvider, PermanentProvisioningError } from '../application/ports.ts';

export interface ForgejoOptions {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs?: number;
}

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
  readonly #options: ForgejoOptions;

  constructor(options: ForgejoOptions) {
    this.#options = options;
  }

  async ensureOrganization(organization: GitOrganization): Promise<string> {
    const marker = ownershipMarker(organization.companyId);
    const existing = await this.#request('GET', `/orgs/${encodeURIComponent(organization.name)}`);

    if (existing.status === 404) {
      const created = await this.#request('POST', '/orgs', {
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
      const updated = await this.#request('PATCH', `/orgs/${encodeURIComponent(organization.name)}`, {
        full_name: organization.displayName,
        visibility: 'private',
      });
      await expectOk(updated, 'update the Git organization');
    }
    return String(current.id);
  }

  async #request(method: string, path: string, body?: object): Promise<Response> {
    const credentials = Buffer.from(`${this.#options.username}:${this.#options.password}`).toString('base64');
    try {
      return await fetch(`${this.#options.url.replace(/\/$/, '')}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 10_000),
      });
    } catch {
      throw new Error('The Git service could not be reached.');
    }
  }
}

export function ownershipMarker(companyId: string): string {
  return `Managed by DreamDevOps for company ${companyId}. Do not edit this description.`;
}

async function expectOk(response: Response, action: string): Promise<void> {
  if (response.ok) {
    return;
  }
  if (response.status === 401 || response.status === 403) {
    throw new PermanentProvisioningError(`The Git service refused the platform's credentials to ${action}.`);
  }
  // Server errors may pass, so they are retried. Details stay out of the message.
  throw new Error(`The Git service could not ${action} (status ${response.status}).`);
}
