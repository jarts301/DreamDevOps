import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('configuration', () => {
  it('uses port 8080 on every network interface by default, and lets no web page call it', () => {
    expect(loadConfig({})).toEqual({ host: '0.0.0.0', port: 8080, corsOrigins: [] });
  });

  it('refuses a port that is not valid', () => {
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow('PORT must be a whole number');
  });

  it('lets the web pages it lists call it', () => {
    expect(loadConfig({ CORS_ORIGINS: ' https://shop.example.com, http://localhost:49154 ,' }).corsOrigins).toEqual([
      'https://shop.example.com',
      'http://localhost:49154',
    ]);
  });

  it('refuses something that is not an origin', () => {
    for (const value of ['*', 'shop.example.com', 'https://shop.example.com/path']) {
      expect(() => loadConfig({ CORS_ORIGINS: value })).toThrow('CORS_ORIGINS must list origins');
    }
  });
});
