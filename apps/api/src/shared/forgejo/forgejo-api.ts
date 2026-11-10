/** How the platform bot reaches Forgejo's REST API. */
export interface ForgejoConnection {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  /** How long a request may take. Each adapter has its own default. */
  readonly timeoutMs?: number;
}

/** An error that retrying can't fix. Each module has its own, so its callers can tell. */
export type PermanentErrorType = new (message: string) => Error;

/**
 * Forgejo's REST API, signed in as the platform bot. Each module's Forgejo adapter is
 * built on it, so they all reach Forgejo, time out and report failures the same way.
 *
 * It belongs to no module: when modules become separate services, it becomes a small
 * shared library.
 */
export class ForgejoApi {
  readonly #connection: ForgejoConnection;
  readonly #timeoutMs: number;

  constructor(connection: ForgejoConnection, options: { readonly defaultTimeoutMs: number }) {
    this.#connection = connection;
    this.#timeoutMs = connection.timeoutMs ?? options.defaultTimeoutMs;
  }

  /** The bot's username, such as for rules that only the bot may push to. */
  get username(): string {
    return this.#connection.username;
  }

  /** Sends a request to /api/v1. Any answer is returned. Only an unreachable server throws. */
  async request(
    method: string,
    path: string,
    body?: object,
    options: { readonly accept?: string; readonly timeoutMs?: number } = {},
  ): Promise<Response> {
    const credentials = Buffer.from(`${this.#connection.username}:${this.#connection.password}`).toString('base64');
    try {
      return await fetch(`${this.#connection.url.replace(/\/$/, '')}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: options.accept ?? 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs),
      });
    } catch {
      throw new Error('The Git service could not be reached.');
    }
  }
}

/**
 * Throws unless Forgejo answered with success. Refused credentials can't be fixed by
 * retrying, so they throw the module's permanent error. Anything else, such as a server
 * error, may pass, so it throws a plain Error to be retried. Details stay out of messages.
 */
export async function expectOk(response: Response, action: string, permanent: PermanentErrorType): Promise<void> {
  if (response.ok) {
    return;
  }
  await response.body?.cancel();
  if (response.status === 401 || response.status === 403) {
    throw new permanent(`The Git service refused the platform's credentials to ${action}.`);
  }
  throw new Error(`The Git service could not ${action} (status ${response.status}).`);
}

/** Puts a name in a path. */
export function segment(value: string): string {
  return encodeURIComponent(value);
}

/** Puts a branch or tag name in a path. Its slashes stay, as path separators. */
export function refPath(name: string): string {
  return name.split('/').map(encodeURIComponent).join('/');
}
