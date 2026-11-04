import { describe, expect, it } from 'vitest';
import { InvalidConfigError, loadConfig } from '../src/config/app-config.ts';

const valid = {
  API_DATABASE_URL: 'postgres://app@localhost/dreamdevops',
  API_PUBLIC_URL: 'http://localhost:4000/',
  DASHBOARD_URL: 'http://localhost:4200',
  KEYCLOAK_ISSUER_URL: 'http://localhost:8081/realms/dreamdevops',
  KEYCLOAK_CLIENT_ID: 'dreamdevops-dashboard',
  KEYCLOAK_CLIENT_SECRET: 'fake-dummy-client-secret',
};

const production = { ...valid, NODE_ENV: 'production', KEYCLOAK_ISSUER_URL: 'https://login.example.com/realms/dreamdevops' };

describe('loadConfig', () => {
  it('reads valid settings and applies safe defaults', () => {
    const config = loadConfig(valid);

    expect(config.publicUrl).toBe('http://localhost:4000');
    expect(config.secureCookies).toBe(true);
    expect(config.requireVerifiedEmail).toBe(true);
    expect(config.trustedProxies).toBe(0);
  });

  it('accepts a safe production setup', () => {
    expect(loadConfig(production).environment).toBe('production');
  });

  it('refuses a login provider without https in production', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow(InvalidConfigError);
  });

  it.each(['SECURE_COOKIES', 'REQUIRE_VERIFIED_EMAIL'])('refuses to turn off %s in production', (name) => {
    expect(() => loadConfig({ ...production, [name]: 'false' })).toThrow(InvalidConfigError);
  });

  it.each([
    'API_DATABASE_URL',
    'API_PUBLIC_URL',
    'DASHBOARD_URL',
    'KEYCLOAK_ISSUER_URL',
    'KEYCLOAK_CLIENT_ID',
    'KEYCLOAK_CLIENT_SECRET',
  ])('requires %s', (name) => {
    expect(() => loadConfig({ ...valid, [name]: undefined })).toThrow(InvalidConfigError);
  });

  it('rejects a URL that is not valid', () => {
    expect(() => loadConfig({ ...valid, DASHBOARD_URL: 'not a url' })).toThrow(InvalidConfigError);
  });

  it('rejects numbers that are not valid', () => {
    expect(() => loadConfig({ ...valid, API_PORT: 'abc' })).toThrow(InvalidConfigError);
  });
});
