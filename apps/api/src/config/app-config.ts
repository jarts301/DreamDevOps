import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  readonly environment: string;
  readonly port: number;
  /** Connection string for the dreamdevops_app role. */
  readonly databaseUrl: string;
  /** Where the browser reaches the API, such as http://localhost:4000. */
  readonly publicUrl: string;
  /** Where the browser goes after login. Its origin may send state-changing requests. */
  readonly dashboardUrl: string;
  readonly keycloakIssuerUrl: string;
  readonly keycloakClientId: string;
  readonly keycloakClientSecret: string;
  /** Whether a user's email must be verified before they can accept an invitation. */
  readonly requireVerifiedEmail: boolean;
  readonly secureCookies: boolean;
  readonly sessionIdleMs: number;
  readonly sessionAbsoluteMs: number;
  readonly rateLimitPerMinute: number;
  readonly authRateLimitPerMinute: number;
  /** Number of reverse proxies in front of the API, used to find the client's address. */
  readonly trustedProxies: number;
  /** Connection string for the dreamdevops_relay role, used by the outbox relay. */
  readonly relayDatabaseUrl: string;
  /** Connection string for the dreamdevops_jobs role, used by the job queue. */
  readonly jobsDatabaseUrl: string;
  readonly relayPollMs: number;
  readonly jobPollingSeconds: number;
  readonly forgejoUrl: string;
  readonly forgejoUsername: string;
  readonly forgejoPassword: string;
  /** Forgejo's address in people's browsers, for links. Defaults to FORGEJO_URL. */
  readonly forgejoPublicUrl: string;
  /** The folder of versioned blueprints. Defaults to the repository's blueprints folder. */
  readonly blueprintsDir: string;
  /** Attempts before a company's provisioning is marked as failed. */
  readonly provisioningMaxAttempts: number;
  readonly provisioningRetrySeconds: number;
  readonly smtpHost: string;
  readonly smtpPort: number;
  /** The sender, such as "DreamDevOps <no-reply@example.com>". */
  readonly smtpFrom: string;
  readonly smtpSecurity: 'tls' | 'starttls' | 'none';
  readonly smtpUsername: string | null;
  readonly smtpPassword: string | null;
  /** Allows http:// webhook addresses. For local testing only. */
  readonly webhookAllowInsecure: boolean;
  /** Allows webhooks to reach internal and local addresses. For local testing only. */
  readonly webhookAllowPrivateNetworks: boolean;
  readonly notificationRetrySeconds: number;
  /** Where Forgejo sends webhooks about new branches and merges. It must reach this API. */
  readonly forgejoWebhookUrl: string;
  /** The master secret each repository's webhook secret is made from. */
  readonly forgejoWebhookSecret: string;
  /** The registry images are published to. Defaults to Forgejo's own, at FORGEJO_URL. */
  readonly registryUrl: string;
  /** The ECDSA P-256 private key, in PEM, that signs every image. */
  readonly imageSigningKeyFile: string;
  /** Whether images are scanned for vulnerabilities. "none" is for local testing only. */
  readonly imageScanner: 'trivy' | 'none';
  /** The Trivy image that scans images. */
  readonly trivyImage: string;
  /** How many builds run at once in this API process. */
  readonly buildConcurrency: number;
  readonly buildTimeoutMs: number;
  /** Attempts before a build that keeps hitting temporary problems is marked as failed. */
  readonly buildMaxAttempts: number;
  readonly buildRetrySeconds: number;
  /** Whether companies may run applications on this server's own Docker. */
  readonly localHosting: boolean;
  /** Where applications on this machine publish their ports. 127.0.0.1 keeps them to this machine. */
  readonly localHostingBindAddress: string;
  /** Attempts before a deployment that keeps hitting temporary problems is marked as failed. */
  readonly deployMaxAttempts: number;
  readonly deployRetrySeconds: number;
  /** How long a new version has to become healthy before it's rolled back. */
  readonly deployHealthTimeoutMs: number;
  /** The key, 32 bytes in base64, that seals environments' secrets. */
  readonly secretsKeyFile: string;
  /**
   * The Prometheus server the API reads applications' metrics from, such as
   * http://localhost:9090. Without it, the dashboard shows no metrics.
   */
  readonly prometheusUrl: string | null;
  /**
   * Where applications send their metrics over OTLP, as their containers reach it, such as
   * http://host.docker.internal:9090/api/v1/otlp/v1/metrics. Without it, they're told nowhere.
   */
  readonly appMetricsEndpoint: string | null;
  /**
   * The Jaeger server the API reads applications' traces from, such as
   * http://localhost:16686. Without it, the dashboard shows no traces.
   */
  readonly jaegerUrl: string | null;
  /**
   * Where applications send their traces over OTLP, as their containers reach it, such as
   * http://host.docker.internal:4318/v1/traces. Without it, they're told nowhere.
   */
  readonly appTracesEndpoint: string | null;
  /**
   * Sample data for local development: a sample company with a sample account in each
   * role. Never in production.
   */
  readonly sampleData: {
    /** Keycloak's own administrator, who can add sample accounts an older realm lacks. */
    readonly keycloakAdminUsername: string;
    readonly keycloakAdminPassword: string;
    /** The password new sample accounts get. */
    readonly password: string;
  } | null;
}

export class InvalidConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigError';
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

const MINUTE_MS = 60_000;
// Three folders up from both src/config and dist/config is the repository root.
const DEFAULT_BLUEPRINTS_DIR = fileURLToPath(new URL('../../../../blueprints', import.meta.url));
// Created on first use on a developer's machine. Git ignores the folder.
const DEFAULT_SIGNING_KEY_FILE = fileURLToPath(new URL('../../../../infra/local/signing/image-signing.key', import.meta.url));
// Created on first use on a developer's machine, like the signing key. Git ignores the folder.
const DEFAULT_SECRETS_KEY_FILE = fileURLToPath(new URL('../../../../infra/local/secrets/environment-secrets.key', import.meta.url));
const DEFAULT_TRIVY_IMAGE = 'aquasec/trivy:0.58.1';
const MIN_PRODUCTION_SECRET_LENGTH = 32;

/** Reads settings once at startup and refuses to start if any are unsafe or missing. */
export function loadConfig(env: Environment): AppConfig {
  const environment = env.NODE_ENV ?? 'development';
  const isProduction = environment === 'production';

  const keycloakIssuerUrl = url(env, 'KEYCLOAK_ISSUER_URL');
  const secureCookies = env.SECURE_COOKIES !== 'false';
  const requireVerifiedEmail = env.REQUIRE_VERIFIED_EMAIL !== 'false';
  const smtpSecurity = env.SMTP_SECURITY ?? 'starttls';
  if (smtpSecurity !== 'tls' && smtpSecurity !== 'starttls' && smtpSecurity !== 'none') {
    throw new InvalidConfigError('SMTP_SECURITY must be tls, starttls or none.');
  }
  const webhookAllowInsecure = env.WEBHOOK_ALLOW_INSECURE === 'true';
  const webhookAllowPrivateNetworks = env.WEBHOOK_ALLOW_PRIVATE_NETWORKS === 'true';
  if (isProduction && (smtpSecurity === 'none' || webhookAllowInsecure || webhookAllowPrivateNetworks)) {
    throw new InvalidConfigError(
      'SMTP_SECURITY=none, WEBHOOK_ALLOW_INSECURE and WEBHOOK_ALLOW_PRIVATE_NETWORKS are for local testing only.',
    );
  }
  const imageScanner = env.IMAGE_SCANNER ?? 'trivy';
  if (imageScanner !== 'trivy' && imageScanner !== 'none') {
    throw new InvalidConfigError('IMAGE_SCANNER must be trivy or none.');
  }
  const localHosting = env.LOCAL_HOSTING ?? 'on';
  if (localHosting !== 'on' && localHosting !== 'off') {
    throw new InvalidConfigError('LOCAL_HOSTING must be on or off.');
  }
  const localHostingBindAddress = env.LOCAL_HOSTING_BIND_ADDRESS || '127.0.0.1';
  if (isIP(localHostingBindAddress) === 0) {
    throw new InvalidConfigError('LOCAL_HOSTING_BIND_ADDRESS must be an IP address, such as 127.0.0.1.');
  }
  const sampleData = env.SAMPLE_DATA ?? 'off';
  if (sampleData !== 'on' && sampleData !== 'off') {
    throw new InvalidConfigError('SAMPLE_DATA must be on or off.');
  }
  if (isProduction && sampleData === 'on') {
    throw new InvalidConfigError('SAMPLE_DATA is for local development only.');
  }
  const forgejoWebhookSecret = required(env, 'FORGEJO_WEBHOOK_SECRET');
  if (isProduction) {
    if (imageScanner === 'none') {
      throw new InvalidConfigError('IMAGE_SCANNER=none is for local testing only.');
    }
    if (forgejoWebhookSecret.length < MIN_PRODUCTION_SECRET_LENGTH) {
      throw new InvalidConfigError(`FORGEJO_WEBHOOK_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production.`);
    }
    if (!env.IMAGE_SIGNING_KEY_FILE) {
      throw new InvalidConfigError('IMAGE_SIGNING_KEY_FILE must be set in production.');
    }
    if (!env.SECRETS_KEY_FILE) {
      throw new InvalidConfigError('SECRETS_KEY_FILE must be set in production.');
    }
    if (!keycloakIssuerUrl.startsWith('https://')) {
      throw new InvalidConfigError('KEYCLOAK_ISSUER_URL must use https in production.');
    }
    if (!secureCookies || !requireVerifiedEmail) {
      throw new InvalidConfigError('SECURE_COOKIES and REQUIRE_VERIFIED_EMAIL cannot be turned off in production.');
    }
  }

  return {
    environment,
    port: integer(env, 'API_PORT', 4000),
    databaseUrl: required(env, 'API_DATABASE_URL'),
    publicUrl: url(env, 'API_PUBLIC_URL'),
    dashboardUrl: url(env, 'DASHBOARD_URL'),
    keycloakIssuerUrl,
    keycloakClientId: required(env, 'KEYCLOAK_CLIENT_ID'),
    keycloakClientSecret: required(env, 'KEYCLOAK_CLIENT_SECRET'),
    requireVerifiedEmail,
    secureCookies,
    sessionIdleMs: integer(env, 'SESSION_IDLE_MINUTES', 30) * MINUTE_MS,
    sessionAbsoluteMs: integer(env, 'SESSION_ABSOLUTE_MINUTES', 480) * MINUTE_MS,
    rateLimitPerMinute: integer(env, 'RATE_LIMIT_PER_MINUTE', 300),
    authRateLimitPerMinute: integer(env, 'AUTH_RATE_LIMIT_PER_MINUTE', 20),
    trustedProxies: integer(env, 'TRUSTED_PROXIES', 0),
    relayDatabaseUrl: required(env, 'RELAY_DATABASE_URL'),
    jobsDatabaseUrl: required(env, 'JOBS_DATABASE_URL'),
    relayPollMs: integer(env, 'RELAY_POLL_MS', 1_000),
    jobPollingSeconds: integer(env, 'JOB_POLLING_SECONDS', 2),
    forgejoUrl: url(env, 'FORGEJO_URL'),
    forgejoUsername: required(env, 'FORGEJO_BOT_USERNAME'),
    forgejoPassword: required(env, 'FORGEJO_BOT_PASSWORD'),
    forgejoPublicUrl: env.FORGEJO_PUBLIC_URL ? url(env, 'FORGEJO_PUBLIC_URL') : url(env, 'FORGEJO_URL'),
    blueprintsDir: env.BLUEPRINTS_DIR || DEFAULT_BLUEPRINTS_DIR,
    provisioningMaxAttempts: integer(env, 'PROVISIONING_MAX_ATTEMPTS', 5),
    provisioningRetrySeconds: integer(env, 'PROVISIONING_RETRY_SECONDS', 30),
    smtpHost: required(env, 'SMTP_HOST'),
    smtpPort: integer(env, 'SMTP_PORT', 587),
    smtpFrom: required(env, 'SMTP_FROM'),
    smtpSecurity,
    smtpUsername: env.SMTP_USERNAME || null,
    smtpPassword: env.SMTP_PASSWORD || null,
    webhookAllowInsecure,
    webhookAllowPrivateNetworks,
    notificationRetrySeconds: integer(env, 'NOTIFICATION_RETRY_SECONDS', 30),
    forgejoWebhookUrl: env.FORGEJO_WEBHOOK_URL
      ? url(env, 'FORGEJO_WEBHOOK_URL')
      : `${url(env, 'API_PUBLIC_URL')}/api/v1/hooks/forgejo`,
    forgejoWebhookSecret,
    registryUrl: env.IMAGE_REGISTRY_URL ? url(env, 'IMAGE_REGISTRY_URL') : url(env, 'FORGEJO_URL'),
    imageSigningKeyFile: env.IMAGE_SIGNING_KEY_FILE || DEFAULT_SIGNING_KEY_FILE,
    imageScanner,
    trivyImage: env.TRIVY_IMAGE || DEFAULT_TRIVY_IMAGE,
    buildConcurrency: Math.max(1, integer(env, 'BUILD_CONCURRENCY', 1)),
    buildTimeoutMs: Math.max(1, integer(env, 'BUILD_TIMEOUT_MINUTES', 30)) * MINUTE_MS,
    buildMaxAttempts: Math.max(1, integer(env, 'BUILD_MAX_ATTEMPTS', 3)),
    buildRetrySeconds: integer(env, 'BUILD_RETRY_SECONDS', 30),
    localHosting: localHosting === 'on',
    localHostingBindAddress,
    deployMaxAttempts: Math.max(1, integer(env, 'DEPLOY_MAX_ATTEMPTS', 2)),
    deployRetrySeconds: integer(env, 'DEPLOY_RETRY_SECONDS', 15),
    deployHealthTimeoutMs: Math.max(1, integer(env, 'DEPLOY_HEALTH_TIMEOUT_SECONDS', 120)) * 1000,
    secretsKeyFile: env.SECRETS_KEY_FILE || DEFAULT_SECRETS_KEY_FILE,
    prometheusUrl: optionalHttpUrl(env, 'PROMETHEUS_URL'),
    appMetricsEndpoint: optionalHttpUrl(env, 'APP_METRICS_OTLP_ENDPOINT'),
    jaegerUrl: optionalHttpUrl(env, 'JAEGER_URL'),
    appTracesEndpoint: optionalHttpUrl(env, 'APP_TRACES_OTLP_ENDPOINT'),
    sampleData:
      sampleData === 'on'
        ? {
            keycloakAdminUsername: required(env, 'KEYCLOAK_ADMIN_USERNAME'),
            keycloakAdminPassword: required(env, 'KEYCLOAK_ADMIN_PASSWORD'),
            password: required(env, 'KEYCLOAK_DEV_USER_PASSWORD'),
          }
        : null,
  };
}

function required(env: Environment, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new InvalidConfigError(`${name} must be set.`);
  }
  return value;
}

function url(env: Environment, name: string): string {
  const value = required(env, name);
  if (!URL.canParse(value)) {
    throw new InvalidConfigError(`${name} must be a full URL.`);
  }
  return value.replace(/\/$/, '');
}

/** An http or https address, or null when the setting is left out. */
function optionalHttpUrl(env: Environment, name: string): string | null {
  if (!env[name]) {
    return null;
  }
  const value = url(env, name);
  if (!/^https?:\/\//i.test(value)) {
    throw new InvalidConfigError(`${name} must be an http or https address.`);
  }
  return value;
}

function integer(env: Environment, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidConfigError(`${name} must be a non-negative whole number.`);
  }
  return parsed;
}
