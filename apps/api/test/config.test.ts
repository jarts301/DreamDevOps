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
  FORGEJO_WEBHOOK_SECRET: 'fake-dummy-webhook-secret',
  SMTP_HOST: 'smtp.example.com',
  SMTP_FROM: 'DreamDevOps <no-reply@example.com>',
};

const production = {
  ...valid,
  NODE_ENV: 'production',
  KEYCLOAK_ISSUER_URL: 'https://login.example.com/realms/dreamdevops',
  FORGEJO_WEBHOOK_SECRET: 'a-webhook-secret-that-is-long-enough-for-production',
  IMAGE_SIGNING_KEY_FILE: '/etc/dreamdevops/image-signing.key',
  SECRETS_KEY_FILE: '/etc/dreamdevops/environment-secrets.key',
};

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
    ['SMTP_SECURITY', 'none'],
    ['WEBHOOK_ALLOW_INSECURE', 'true'],
    ['WEBHOOK_ALLOW_PRIVATE_NETWORKS', 'true'],
  ])('refuses %s=%s in production', (name, value) => {
    expect(() => loadConfig({ ...production, [name]: value })).toThrow(InvalidConfigError);
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
    'FORGEJO_WEBHOOK_SECRET',
    'SMTP_HOST',
    'SMTP_FROM',
  ])('requires %s', (name) => {
    expect(() => loadConfig({ ...valid, [name]: undefined })).toThrow(InvalidConfigError);
  });

  it('builds and publishes images with safe defaults', () => {
    const config = loadConfig(valid);

    expect(config.forgejoWebhookUrl).toBe('http://localhost:4000/api/v1/hooks/forgejo');
    expect(config.registryUrl).toBe('http://localhost:3000');
    expect(config.imageScanner).toBe('trivy');
    expect(config.imageSigningKeyFile).toMatch(/infra[/\\]local[/\\]signing[/\\]image-signing\.key$/);
    expect(config.buildConcurrency).toBe(1);
    expect(config.buildMaxAttempts).toBe(3);
    expect(config.buildTimeoutMs).toBe(30 * 60_000);
  });

  it('lets the webhook address and registry be set', () => {
    const config = loadConfig({
      ...valid,
      FORGEJO_WEBHOOK_URL: 'http://host.docker.internal:4000/api/v1/hooks/forgejo',
      IMAGE_REGISTRY_URL: 'https://registry.example.com/',
    });

    expect(config.forgejoWebhookUrl).toBe('http://host.docker.internal:4000/api/v1/hooks/forgejo');
    expect(config.registryUrl).toBe('https://registry.example.com');
  });

  it('runs applications on this machine by default, reachable only from it', () => {
    const config = loadConfig(valid);

    expect(config.localHosting).toBe(true);
    expect(config.localHostingBindAddress).toBe('127.0.0.1');
    expect(config.deployMaxAttempts).toBe(2);
    expect(config.deployHealthTimeoutMs).toBe(120_000);
    expect(loadConfig({ ...valid, LOCAL_HOSTING: 'off' }).localHosting).toBe(false);
    expect(loadConfig({ ...valid, LOCAL_HOSTING_BIND_ADDRESS: '0.0.0.0' }).localHostingBindAddress).toBe('0.0.0.0');
    expect(config.secretsKeyFile).toMatch(/infra[/\\]local[/\\]secrets[/\\]environment-secrets\.key$/);
  });

  it.each([
    ['LOCAL_HOSTING', 'yes'],
    ['LOCAL_HOSTING_BIND_ADDRESS', 'localhost'],
    ['DEPLOY_HEALTH_TIMEOUT_SECONDS', 'soon'],
  ])('refuses %s=%s', (name, value) => {
    expect(() => loadConfig({ ...valid, [name]: value })).toThrow(InvalidConfigError);
  });

  it('refuses an unknown scanner', () => {
    expect(() => loadConfig({ ...valid, IMAGE_SCANNER: 'grype' })).toThrow(InvalidConfigError);
  });

  it.each([
    ['IMAGE_SCANNER', 'none'],
    ['FORGEJO_WEBHOOK_SECRET', 'too-short'],
    ['IMAGE_SIGNING_KEY_FILE', ''],
    ['SECRETS_KEY_FILE', ''],
  ])('refuses %s=%s in production', (name, value) => {
    expect(() => loadConfig({ ...production, [name]: value })).toThrow(InvalidConfigError);
  });

  it('rejects a URL that is not valid', () => {
    expect(() => loadConfig({ ...valid, DASHBOARD_URL: 'not a url' })).toThrow(InvalidConfigError);
  });

  it('rejects numbers that are not valid', () => {
    expect(() => loadConfig({ ...valid, API_PORT: 'abc' })).toThrow(InvalidConfigError);
  });
});
