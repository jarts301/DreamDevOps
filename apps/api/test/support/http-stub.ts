import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: unknown;
}

export interface StubAnswer {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** Answers a request, or returns undefined to fall through to the next route. */
export type StubRoute = (request: RecordedRequest) => StubAnswer | undefined;

/**
 * A throwaway HTTP server for testing adapters of other tools. It records every request
 * and answers from routes the test sets, or 404.
 */
export class HttpStub {
  readonly requests: RecordedRequest[] = [];
  readonly #routes: StubRoute[] = [];
  #server: Server | undefined;
  url = '';

  /** Routes added later are tried first, so a test can override a default. */
  on(method: string, path: string | RegExp, answer: StubAnswer | ((request: RecordedRequest) => StubAnswer)): this {
    this.#routes.unshift((request) => {
      const matches = typeof path === 'string' ? request.path === path : path.test(request.path);
      if (request.method !== method || !matches) {
        return undefined;
      }
      return typeof answer === 'function' ? answer(request) : answer;
    });
    return this;
  }

  reset(): void {
    this.requests.length = 0;
    this.#routes.length = 0;
  }

  /** The requests made, as "METHOD /path". */
  calls(): string[] {
    return this.requests.map((request) => `${request.method} ${request.path}`);
  }

  async start(): Promise<this> {
    this.#server = createServer((incoming, response) => void this.#handle(incoming, response));
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server === undefined ? resolve() : this.#server.close(() => resolve())));
  }

  async #handle(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown = text;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      // Not JSON, so it's kept as text.
    }
    const url = new URL(incoming.url ?? '/', 'http://stub');
    const request: RecordedRequest = {
      method: incoming.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers: incoming.headers,
      body,
    };
    this.requests.push(request);
    const answer = this.#routes.map((route) => route(request)).find((candidate) => candidate !== undefined) ?? {
      status: 404,
      body: { message: 'not found' },
    };
    response.statusCode = answer.status ?? 200;
    for (const [name, value] of Object.entries(answer.headers ?? {})) {
      response.setHeader(name, value);
    }
    if (answer.body === undefined) {
      response.end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(answer.body));
  }
}
