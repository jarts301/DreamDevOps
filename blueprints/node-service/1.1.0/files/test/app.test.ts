import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

describe('the service', () => {
  const app = buildApp();

  afterAll(() => app.close());

  it('reports that it is alive and ready', async () => {
    for (const url of ['/health/live', '/health/ready']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    }
  });

  it('greets by name', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/hello?name=Ada' });
    expect(response.json()).toEqual({ message: 'Hello, Ada!' });
  });

  it('refuses unexpected input', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/hello?name=' });
    expect(response.statusCode).toBe(400);
  });
});
