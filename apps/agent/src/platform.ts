import type {
  AgentCommand,
  CommandResult,
  HeartbeatRequest,
  HeartbeatResponse,
  Registration,
  RegistrationRequest,
  TargetConfiguration,
  TokenResponse,
} from '@dreamdevops/contracts/agent/protocol';
import { signAssertion } from './identity.ts';

/**
 * What the agent and the platform say to each other is the platform's agent protocol, in
 * its contracts. They're imported as types only, so this program needs nothing else.
 */
export type {
  AgentCommand as Command,
  HeartbeatRequest,
  HeartbeatResponse,
  Registration,
  SyncReport,
  TargetConfiguration as Configuration,
  WorkloadReport,
} from '@dreamdevops/contracts/agent/protocol';

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

  register(input: RegistrationRequest): Promise<Registration> {
    return this.#call('POST', '/agent/register', input) as Promise<Registration>;
  }

  async setDeployKey(identity: Identity, publicKey: string): Promise<void> {
    await this.#call('PUT', '/agent/deploy-key', { publicKey }, await this.#token(identity));
  }

  async configuration(identity: Identity): Promise<TargetConfiguration> {
    return (await this.#call('GET', '/agent/configuration', undefined, await this.#token(identity))) as TargetConfiguration;
  }

  async heartbeat(identity: Identity, report: HeartbeatRequest): Promise<HeartbeatResponse> {
    const answer = (await this.#call('POST', '/agent/heartbeat', report, await this.#token(identity))) as Partial<HeartbeatResponse> & {
      heartbeatSeconds: number;
    };
    // Commands came later than heartbeats, so an older platform may send none.
    const commands: readonly AgentCommand[] = answer.commands ?? [];
    return { heartbeatSeconds: answer.heartbeatSeconds, commands };
  }

  async commandDone(identity: Identity, id: string, result: CommandResult): Promise<void> {
    await this.#call('POST', `/agent/commands/${encodeURIComponent(id)}`, result, await this.#token(identity));
  }

  /** A short-lived access token, swapped for a fresh signed assertion when needed. */
  async #token(identity: Identity): Promise<string> {
    if (this.#accessToken !== null && this.#accessToken.expiresAt - Date.now() > 60_000) {
      return this.#accessToken.value;
    }
    const assertion = signAssertion(identity.targetId, identity.privateKey, `${this.#url}/api/v1/agent/token`);
    const { accessToken, expiresIn } = (await this.#call('POST', '/agent/token', { assertion })) as TokenResponse;
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
