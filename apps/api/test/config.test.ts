import { describe, expect, it } from 'vitest';
import { InvalidConfigError, loadConfig } from '../src/config/app-config.ts';

const valid = {
  API_DATABASE_URL: 'postgres://app@localhost/dreamdevops',
  API_PUBLIC_URL: 'http://localhost:4000/',
  DASHBOARD_URL: 'http://localhost:4200',
  KEYCLOAK_ISSUER_URL: 'http://localhost:8081/realms/dreamdevops',
  KEYCLOAK_CLIENT_ID: 'dreamdevops-dashboard',
  KEYCLOAK_CLIENT_SECRET: 'fake-dummy-client-secret',
  RELAY_DATABASE_URL: 'postgres://relay@localhost/dreamdevops',
  JOBS_DATABASE_URL: 'postgres://jobs@localhost/dreamdevops',
  FORGEJO_URL: 'http://localhost:3000',
  FORGEJO_BOT_USERNAME: 'dreamdevops-bot',
  FORGEJO_BOT_PASSWORD: 'fake-dummy-bot-password',
  SMTP_HOST: 'smtp.example.com',
  SMTP_FROM: 'DreamDevOps <no-reply@example.com>',
  WEBHOOK_SECRET_KEY: 'fake-dummy-webhook-secret-key-for-tests-only',
  SIGNING_KEY_SECRET: 'fake-dummy-signing-key-secret-for-tests-only',
  IMAGE_RUNNER_LABEL: 'fake-dummy-image-runner',
};

const production = {
  ...valid,
  NODE_ENV: 'production',
  KEYCLOAK_ISSUER_URL: 'https://login.example.com/realms/dreamdevops',
  WEBHOOK_SECRET_KEY: 'a-real-webhook-secret-key-that-is-long-enough',
  SIGNING_KEY_SECRET: 'a-real-signing-key-secret-that-is-long-enough',
  IMAGE_RUNNER_LABEL: 'image-runner-3f9a2c7d41e6',
  AGENT_API_URL: 'https://api.example.com',
};

describe('loadConfig', () => {
  it('reads valid settings and applies safe defaults', () => {
    const config = loadConfig(valid);

    expect(config.publicUrl).toBe('http://localhost:4000');
    expect(config.secureCookies).toBe(true);
    expect(config.requireVerifiedEmail).toBe(true);
    expect(config.trustedProxies).toBe(0);
    expect(config.toolsApiUrl).toBe('http://localhost:4000');
    expect(config.buildTimeoutMinutes).toBe(60);
  });

  it('lets tools reach the API at another address', () => {
    expect(loadConfig({ ...valid, TOOLS_API_URL: 'http://host.docker.internal:4000/' }).toolsApiUrl).toBe(
      'http://host.docker.internal:4000',
    );
  });

  it.each(['WEBHOOK_SECRET_KEY', 'SIGNING_KEY_SECRET'])('refuses a short %s', (name) => {
    expect(() => loadConfig({ ...valid, [name]: 'too-short' })).toThrow('must be at least 32 characters');
  });

  it('refuses an image runner label that is not valid', () => {
    expect(() => loadConfig({ ...valid, IMAGE_RUNNER_LABEL: 'Bad Label' })).toThrow('IMAGE_RUNNER_LABEL must be');
  });

  it.each(['WEBHOOK_SECRET_KEY', 'SIGNING_KEY_SECRET', 'IMAGE_RUNNER_LABEL'])('refuses the sample %s in production', (name) => {
    expect(() => loadConfig({ ...production, [name]: valid[name as keyof typeof valid] })).toThrow(
      'must not be the sample values in production',
    );
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
    ['SMTP_SECURITY', 'none'],
    ['WEBHOOK_ALLOW_INSECURE', 'true'],
    ['WEBHOOK_ALLOW_PRIVATE_NETWORKS', 'true'],
  ])('refuses %s=%s in production', (name, value) => {
    expect(() => loadConfig({ ...production, [name]: value })).toThrow(InvalidConfigError);
  });

  it('gives agents the public address by default, and refuses http for agents in production', () => {
    const config = loadConfig(valid);
    expect(config.agentApiUrl).toBe(config.publicUrl);
    expect(config.agentChart).toMatch(/^oci:\/\//);
    expect(config.targetLostAfterSeconds).toBe(180);

    expect(() => loadConfig({ ...production, AGENT_API_URL: 'http://api.example.com' })).toThrow(
      'AGENT_API_URL must use https in production.',
    );
    expect(() => loadConfig({ ...valid, AGENT_CHART: 'charts; rm -rf /' })).toThrow(InvalidConfigError);
  });

  it('sets up demo data only when asked, and never in production', () => {
    expect(loadConfig(valid).demoData).toBe(false);
    expect(loadConfig({ ...valid, DEMO_DATA: 'true' }).demoData).toBe(true);
    expect(() => loadConfig({ ...production, DEMO_DATA: 'true' })).toThrow('DEMO_DATA is for local use only.');
  });

  it('defaults to secure email and webhooks', () => {
    const config = loadConfig(valid);

    expect(config.smtpSecurity).toBe('starttls');
    expect(config.webhookAllowInsecure).toBe(false);
    expect(config.webhookAllowPrivateNetworks).toBe(false);
  });

  it.each([
    'API_DATABASE_URL',
    'API_PUBLIC_URL',
    'DASHBOARD_URL',
    'KEYCLOAK_ISSUER_URL',
    'KEYCLOAK_CLIENT_ID',
    'KEYCLOAK_CLIENT_SECRET',
    'RELAY_DATABASE_URL',
    'JOBS_DATABASE_URL',
    'FORGEJO_URL',
    'FORGEJO_BOT_USERNAME',
    'FORGEJO_BOT_PASSWORD',
    'SMTP_HOST',
    'SMTP_FROM',
    'WEBHOOK_SECRET_KEY',
    'SIGNING_KEY_SECRET',
    'IMAGE_RUNNER_LABEL',
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
