export interface AppConfig {
  readonly environment: string;
  readonly port: number;
  /** Connection string for the dreamdevops_app role. */
  readonly databaseUrl: string;
  /** Where the browser reaches the API, such as http://localhost:4000. */
  readonly publicUrl: string;
  /** Where the browser goes after login. Its origin may send state-changing requests. */
  readonly dashboardUrl: string;
  readonly identityProvider: 'fake';
  readonly secureCookies: boolean;
  readonly sessionIdleMs: number;
  readonly sessionAbsoluteMs: number;
  readonly rateLimitPerMinute: number;
  readonly authRateLimitPerMinute: number;
  /** Number of reverse proxies in front of the API, used to find the client's address. */
  readonly trustedProxies: number;
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

  const identityProvider = env.IDENTITY_PROVIDER;
  if (identityProvider !== 'fake') {
    throw new InvalidConfigError('IDENTITY_PROVIDER must be set. Only "fake" exists until Identity and Access is built.');
  }
  if (isProduction) {
    throw new InvalidConfigError('The fake identity provider accepts anyone, so it can never run in production.');
  }

  return {
    environment,
    port: integer(env, 'API_PORT', 4000),
    databaseUrl: required(env, 'API_DATABASE_URL'),
    publicUrl: url(env, 'API_PUBLIC_URL'),
    dashboardUrl: url(env, 'DASHBOARD_URL'),
    identityProvider,
    secureCookies: env.SECURE_COOKIES !== 'false',
    sessionIdleMs: integer(env, 'SESSION_IDLE_MINUTES', 30) * MINUTE_MS,
    sessionAbsoluteMs: integer(env, 'SESSION_ABSOLUTE_MINUTES', 480) * MINUTE_MS,
    rateLimitPerMinute: integer(env, 'RATE_LIMIT_PER_MINUTE', 300),
    authRateLimitPerMinute: integer(env, 'AUTH_RATE_LIMIT_PER_MINUTE', 20),
    trustedProxies: integer(env, 'TRUSTED_PROXIES', 0),
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
