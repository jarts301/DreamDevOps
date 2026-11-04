import { describe, expect, it } from 'vitest';
import { InvalidConfigError, loadConfig } from '../src/config/app-config.ts';

const valid = {
  IDENTITY_PROVIDER: 'fake',
  API_DATABASE_URL: 'postgres://app@localhost/dreamdevops',
  API_PUBLIC_URL: 'http://localhost:4000/',
  DASHBOARD_URL: 'http://localhost:4200',
};

describe('loadConfig', () => {
  it('reads valid settings and applies safe defaults', () => {
    const config = loadConfig(valid);

    expect(config.publicUrl).toBe('http://localhost:4000');
    expect(config.secureCookies).toBe(true);
    expect(config.trustedProxies).toBe(0);
  });

  it('refuses to run the fake identity provider in production', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow(InvalidConfigError);
  });

  it('refuses to start with no identity provider', () => {
    const { IDENTITY_PROVIDER: _removed, ...withoutProvider } = valid;

    expect(() => loadConfig(withoutProvider)).toThrow(InvalidConfigError);
  });

  it.each(['API_DATABASE_URL', 'API_PUBLIC_URL', 'DASHBOARD_URL'])('requires %s', (name) => {
    expect(() => loadConfig({ ...valid, [name]: undefined })).toThrow(InvalidConfigError);
  });

  it('rejects a URL that is not valid', () => {
    expect(() => loadConfig({ ...valid, DASHBOARD_URL: 'not a url' })).toThrow(InvalidConfigError);
  });

  it('rejects numbers that are not valid', () => {
    expect(() => loadConfig({ ...valid, API_PORT: 'abc' })).toThrow(InvalidConfigError);
  });
});
