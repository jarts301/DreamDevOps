import { signAssertion } from './identity.ts';

export interface Registration {
  readonly targetId: string;
  readonly tokenUrl: string;
  readonly heartbeatSeconds: number;
}

/** What the platform says a target needs. It matches the API's TargetConfiguration. */
export interface Configuration {
  readonly environment: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly kind: 'test' | 'production';
    readonly acceptedImages: readonly string[];
  };
  readonly registry: { readonly host: string; readonly organization: string; readonly username: string; readonly token: string };
  readonly trustedKey: string;
  readonly git: { readonly url: string; readonly branch: string; readonly knownHosts: string };
  readonly secrets: { readonly url: string; readonly mount: string; readonly path: string; readonly token: string; readonly expiresAt: string };
}

/** How one deployed workload is doing, as the agent sees it in the cluster. */
export interface WorkloadReport {
  readonly deploymentId: string;
  readonly namespace: string;
  readonly name: string;
  readonly kind: 'Rollout' | 'Deployment';
  readonly phase: 'Progressing' | 'Paused' | 'Healthy' | 'Degraded' | 'Aborted';
  readonly desired: number;
  readonly updated: number;
  readonly ready: number;
  readonly available: number;
  readonly message: string | null;
}

/** Whether Flux applied the environment repository, and which commit. */
export interface SyncReport {
  readonly revision: string | null;
  readonly ready: boolean;
  readonly message: string | null;
}

export interface Command {
  readonly id: string;
  readonly action: 'promote' | 'abort';
  readonly namespace: string;
  readonly name: string;
}

export class PlatformError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'PlatformError';
    this.status = status;
  }
}

/** Calls the platform. Every call goes out from the cluster; nothing calls in. */
export class Platform {
  readonly #url: string;
  #accessToken: { value: string; expiresAt: number } | null = null;

  constructor(url: string) {
    this.#url = url.replace(/\/$/, '');
  }

  register(input: { registrationToken: string; publicKey: object; agentVersion: string; kubernetesVersion: string }): Promise<Registration> {
    return this.#call('POST', '/agent/register', input) as Promise<Registration>;
  }

  async setDeployKey(identity: Identity, publicKey: string): Promise<void> {
    await this.#call('PUT', '/agent/deploy-key', { publicKey }, await this.#token(identity));
  }

  async configuration(identity: Identity): Promise<Configuration> {
    return (await this.#call('GET', '/agent/configuration', undefined, await this.#token(identity))) as Configuration;
  }

  async heartbeat(
    identity: Identity,
    report: { agentVersion: string; kubernetesVersion: string; sync: SyncReport | null; workloads: readonly WorkloadReport[] },
  ): Promise<{ heartbeatSeconds: number; commands: readonly Command[] }> {
    const answer = (await this.#call('POST', '/agent/heartbeat', report, await this.#token(identity))) as {
      heartbeatSeconds: number;
      commands?: Command[];
    };
    return { heartbeatSeconds: answer.heartbeatSeconds, commands: answer.commands ?? [] };
  }

  async commandDone(identity: Identity, id: string, result: { succeeded: boolean; message: string | null }): Promise<void> {
    await this.#call('POST', `/agent/commands/${encodeURIComponent(id)}`, result, await this.#token(identity));
  }

  /** A short-lived access token, swapped for a fresh signed assertion when needed. */
  async #token(identity: Identity): Promise<string> {
    if (this.#accessToken !== null && this.#accessToken.expiresAt - Date.now() > 60_000) {
      return this.#accessToken.value;
    }
    const assertion = signAssertion(identity.targetId, identity.privateKey, `${this.#url}/api/v1/agent/token`);
    const { accessToken, expiresIn } = (await this.#call('POST', '/agent/token', { assertion })) as {
      accessToken: string;
      expiresIn: number;
    };
    this.#accessToken = { value: accessToken, expiresAt: Date.now() + expiresIn * 1000 };
    return accessToken;
  }

  /** Forgets the access token, such as after the platform refused it. */
  resetToken(): void {
    this.#accessToken = null;
  }

  async #call(method: string, path: string, body?: object, token?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.#url}/api/v1${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
          ...(token !== undefined && { Authorization: `Bearer ${token}` }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new PlatformError(0, 'The platform could not be reached.');
    }
    const text = await response.text();
    if (!response.ok) {
      const detail = (() => {
        try {
          return (JSON.parse(text) as { detail?: string }).detail;
        } catch {
          return undefined;
        }
      })();
      throw new PlatformError(response.status, detail ?? `The platform answered ${response.status}.`);
    }
    return text === '' ? null : JSON.parse(text);
  }
}

export interface Identity {
  readonly targetId: string;
  readonly privateKey: string;
}
