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
}

export class InvalidConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigError';
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

const MINUTE_MS = 60_000;

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
  if (isProduction) {
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
