import type { SecretStore } from '../application/ports.ts';

export interface OpenBaoOptions {
  readonly url: string;
  readonly token: string;
  /** The key-value store's mount. */
  readonly mount?: string;
  readonly timeoutMs?: number;
}

/** How long a target's read token lasts. Agents ask for a new one well before it ends. */
const TARGET_TOKEN_TTL = '2h';

/**
 * Secrets in OpenBao's key-value store (version 2), which keeps their history. The
 * platform's token can write, patch and delete, but not read values. Each environment's
 * target gets its own short-lived token, limited by a policy to its path.
 */
export class OpenBaoSecretStore implements SecretStore {
  readonly #options: OpenBaoOptions;

  constructor(options: OpenBaoOptions) {
    this.#options = options;
  }

  get #mount(): string {
    return this.#options.mount ?? 'dreamdevops';
  }

  async write(path: string, values: Readonly<Record<string, string>>): Promise<void> {
    // A merge patch keeps the other values, without the platform having to read them.
    const patched = await this.#request('PATCH', `/v1/${this.#mount}/data/${path}`, { data: values }, 'application/merge-patch+json');
    if (patched.status === 404) {
      await expectOk(await this.#request('POST', `/v1/${this.#mount}/data/${path}`, { data: values }), 'save the secret');
      return;
    }
    await expectOk(patched, 'save the secret');
  }

  async remove(path: string, names: readonly string[]): Promise<void> {
    const response = await this.#request(
      'PATCH',
      `/v1/${this.#mount}/data/${path}`,
      { data: Object.fromEntries(names.map((name) => [name, null])) },
      'application/merge-patch+json',
    );
    if (response.status !== 404) {
      await expectOk(response, 'delete the secret');
    }
  }

  async issueReadToken(policyName: string, path: string): Promise<{ token: string; expiresAt: Date }> {
    if (!/^target-[a-z0-9-]+$/.test(policyName)) {
      throw new Error('Target policies are named target-<id>.');
    }
    // Reading its secrets, and looking itself up, which the External Secrets Operator does
    // to check the token. Nothing else: the token has no default policy.
    const policy = [
      `path "${this.#mount}/data/${path}/*" {\n  capabilities = ["read"]\n}`,
      'path "auth/token/lookup-self" {\n  capabilities = ["read"]\n}',
    ].join('\n');
    await expectOk(await this.#request('PUT', `/v1/sys/policies/acl/${policyName}`, { policy }), 'set the target policy');
    const response = await this.#request('POST', '/v1/auth/token/create/target', {
      policies: [policyName],
      ttl: TARGET_TOKEN_TTL,
      no_default_policy: true,
      display_name: policyName,
    });
    await expectOk(response, 'issue a target token');
    const { auth } = (await response.json()) as { auth: { client_token: string; lease_duration: number } };
    return { token: auth.client_token, expiresAt: new Date(Date.now() + auth.lease_duration * 1000) };
  }

  /** Keeps the platform's own periodic token alive. */
  async renew(): Promise<void> {
    await expectOk(await this.#request('POST', '/v1/auth/token/renew-self', {}), 'renew the platform token');
  }

  async #request(method: string, path: string, body: object, contentType = 'application/json'): Promise<Response> {
    try {
      return await fetch(`${this.#options.url.replace(/\/$/, '')}${path}`, {
        method,
        headers: { 'X-Vault-Token': this.#options.token, 'Content-Type': contentType },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 15_000),
      });
    } catch {
      throw new Error('The secret store could not be reached.');
    }
  }
}

async function expectOk(response: Response, action: string): Promise<void> {
  if (!response.ok) {
    // OpenBao's error messages can name paths, so they stay out of what people see.
    throw new Error(`The secret store could not ${action} (status ${response.status}).`);
  }
}
