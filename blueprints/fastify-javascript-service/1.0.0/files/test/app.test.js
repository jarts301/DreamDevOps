import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

/** Collects what the service logs, one JSON object per line. */
function logCollector() {
  /** @type {Record<string, unknown>[]} */
  const lines = [];
  return { lines, stream: { write: (/** @type {string} */ line) => void lines.push(JSON.parse(line)) } };
}

describe('the service', () => {
  const logs = logCollector();
  const app = buildApp({ logStream: logs.stream });

  afterAll(() => app.close());

  it('reports that it is alive and ready, without logging each check', async () => {
    for (const url of ['/health/live', '/health/ready']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    }
    expect(logs.lines).toEqual([]);
  });

  it('answers a ping, and logs it with the request', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/ping' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(logs.lines.map((line) => line.msg)).toEqual(['incoming request', 'Ping received', 'request completed']);
    const ping = logs.lines.find((line) => line.msg === 'Ping received');
    expect(ping).toMatchObject({ level: 30, reqId: logs.lines[0]?.reqId });
  });

  it('greets by name, and logs whom', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/hello?name=Ada' });

    expect(response.json()).toEqual({ message: 'Hello, Ada!' });
    expect(logs.lines.find((line) => line.msg === 'Greeting sent')).toMatchObject({ greeted: 'Ada' });
  });

  it('refuses unexpected input', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/hello?name=' });
    expect(response.statusCode).toBe(400);
  });

  it('lets no other web page call it from a browser, unless told to', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/ping', headers: { origin: 'https://shop.example.com' } });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('calls from web pages', () => {
  const app = buildApp({ corsOrigins: ['https://shop.example.com'] });

  afterAll(() => app.close());

  it('are allowed from the origins it was given, with the trace the page started', async () => {
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/ping',
      headers: { origin: 'https://shop.example.com', 'access-control-request-headers': 'traceparent' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://shop.example.com');
    expect(preflight.headers['access-control-allow-headers']).toContain('traceparent');

    const response = await app.inject({ method: 'GET', url: '/api/ping', headers: { origin: 'https://shop.example.com' } });
    expect(response.headers['access-control-allow-origin']).toBe('https://shop.example.com');
    expect(response.headers.vary).toBe('Origin');
  });

  it('are refused from any other origin', async () => {
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/ping', headers: { origin: 'https://evil.example.com' } });

    expect(preflight.statusCode).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });
});
