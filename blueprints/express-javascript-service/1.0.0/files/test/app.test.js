import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

/** Collects what the service logs, one JSON object per line. */
function logCollector() {
  /** @type {Record<string, unknown>[]} */
  const lines = [];
  return { lines, stream: { write: (/** @type {string} */ line) => void lines.push(JSON.parse(line)) } };
}

/**
 * Starts the service on a free port, and calls it as clients would.
 * @param {import('../src/app.js').AppOptions} options
 */
function serve(options) {
  /** @type {import('node:http').Server} */
  let server;
  let base = '';
  beforeAll(async () => {
    server = buildApp(options).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  /**
   * @param {string} path
   * @param {RequestInit} [init]
   */
  const call = (path, init) => fetch(`${base}${path}`, init);
  return call;
}

describe('the service', () => {
  const logs = logCollector();
  const call = serve({ logStream: logs.stream });

  it('reports that it is alive and ready, without logging each check', async () => {
    for (const path of ['/health/live', '/health/ready']) {
      const response = await call(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    }
    expect(logs.lines).toEqual([]);
  });

  it('answers a ping, and logs it with the request', async () => {
    const response = await call('/api/ping');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(logs.lines.map((line) => line.msg)).toEqual(['Ping received', 'request completed']);
    expect(logs.lines[0]).toMatchObject({ level: 30 });
  });

  it('logs what identifies a request, and never its headers, which can hold credentials', async () => {
    await call('/api/ping', { headers: { authorization: 'Bearer secret-token', cookie: 'session=secret-cookie' } });

    const lines = JSON.stringify(logs.lines);
    expect(lines).not.toContain('secret-token');
    expect(lines).not.toContain('secret-cookie');
    expect(logs.lines.at(-1)).toMatchObject({ msg: 'request completed', req: { method: 'GET', url: '/api/ping' }, res: { statusCode: 200 } });
  });

  it('greets by name, and logs whom', async () => {
    const response = await call('/api/hello?name=Ada');

    expect(await response.json()).toEqual({ message: 'Hello, Ada!' });
    expect(logs.lines.find((line) => line.msg === 'Greeting sent')).toMatchObject({ greeted: 'Ada' });
    expect(await (await call('/api/hello')).json()).toEqual({ message: 'Hello, world!' });
  });

  it('refuses unexpected input', async () => {
    for (const query of ['name=', `name=${'a'.repeat(101)}`, 'name=a&name=b']) {
      expect((await call(`/api/hello?${query}`)).status, query).toBe(400);
    }
  });

  it('answers unknown paths with 404, in JSON', async () => {
    const response = await call('/nowhere');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found.' });
  });

  it('lets no other web page call it from a browser, unless told to', async () => {
    const response = await call('/api/ping', { headers: { origin: 'https://shop.example.com' } });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('calls from web pages', () => {
  const call = serve({ corsOrigins: ['https://shop.example.com'] });

  it('are allowed from the origins it was given, with the trace the page started', async () => {
    const preflight = await call('/api/ping', {
      method: 'OPTIONS',
      headers: { origin: 'https://shop.example.com', 'access-control-request-headers': 'traceparent' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('traceparent');

    const response = await call('/api/ping', { headers: { origin: 'https://shop.example.com' } });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('are refused from any other origin', async () => {
    const preflight = await call('/api/ping', { method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } });

    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });
});
