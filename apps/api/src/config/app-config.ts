import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  /** The folder of the platform's pipeline definitions. Defaults to the repository's pipelines folder. */
  readonly pipelinesDir: string;
  /** The API's address as Forgejo and CI jobs reach it. Defaults to API_PUBLIC_URL. */
  readonly toolsApiUrl: string;
  /** Derives each repository's webhook secret, so none are stored. */
  readonly webhookSecretKey: string;
  /** Encrypts each company's image signing keys in the database. */
  readonly signingKeySecret: string;
  /** Where image uploads wait while a build runs. */
  readonly buildWorkDir: string;
  /** Builds that haven't finished by then are marked as failed. */
  readonly buildTimeoutMinutes: number;
  /** The secret label of the runner that builds images, put in the platform's pipeline. */
  readonly imageRunnerLabel: string;
  /** The API's address as agents in targets reach it. Defaults to API_PUBLIC_URL. */
  readonly agentApiUrl: string;
  /** The Helm chart that installs the agent, shown in the connect command. */
  readonly agentChart: string;
  /** A connected target not heard from for this long counts as lost. */
  readonly targetLostAfterSeconds: number;
  /** Sets up the demo company and its users at startup. Local use only. */
  readonly demoData: boolean;
  /** A Forgejo administrator, used only to create each company's read-only pull account. */
  readonly forgejoAdminUsername: string;
  readonly forgejoAdminPassword: string;
  /** Where the API reaches OpenBao, which keeps each environment's secrets. */
  readonly openbaoUrl: string;
  /** The platform's OpenBao token. It writes secrets but can't read them. */
  readonly openbaoToken: string;
  /** How targets reach OpenBao, the registry and Git. Default: the platform's own addresses. */
  readonly targetOpenbaoUrl: string;
  readonly targetRegistryHost: string;
  /** The SSH address targets clone their environment repository from, such as ssh://git@git.example.com:22. */
  readonly targetGitSshUrl: string;
  /** Forgejo's SSH host keys as targets see them, in known_hosts format. */
  readonly targetGitKnownHosts: string;
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
// Three folders up from both src/config and dist/config is the repository root.
const DEFAULT_BLUEPRINTS_DIR = fileURLToPath(new URL('../../../../blueprints', import.meta.url));
const DEFAULT_PIPELINES_DIR = fileURLToPath(new URL('../../../../pipelines', import.meta.url));
/** The local stack's sample secrets start with this, and must never reach a server. */
/** Where module 15, the Deployment agent, publishes the agent's chart. */
const DEFAULT_AGENT_CHART = 'oci://ghcr.io/dreamdevops/charts/dreamdevops-agent';
const SAMPLE_SECRET_PREFIX = 'fake-dummy-';

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
  const forgejoPublicUrl = env.FORGEJO_PUBLIC_URL ? url(env, 'FORGEJO_PUBLIC_URL') : url(env, 'FORGEJO_URL');
  const openbaoUrl = url(env, 'OPENBAO_URL');
  const openbaoToken = secret(env, 'OPENBAO_TOKEN');
  const webhookSecretKey = secret(env, 'WEBHOOK_SECRET_KEY');
  const signingKeySecret = secret(env, 'SIGNING_KEY_SECRET');
  const imageRunnerLabel = required(env, 'IMAGE_RUNNER_LABEL');
  if (!/^[a-z0-9][a-z0-9-]{7,62}$/.test(imageRunnerLabel)) {
    throw new InvalidConfigError('IMAGE_RUNNER_LABEL must be 8 to 63 lowercase letters, digits and hyphens.');
  }
  if (
    isProduction &&
    [webhookSecretKey, signingKeySecret, imageRunnerLabel, openbaoToken].some((value) => value.startsWith(SAMPLE_SECRET_PREFIX))
  ) {
    throw new InvalidConfigError(
      'WEBHOOK_SECRET_KEY, SIGNING_KEY_SECRET, IMAGE_RUNNER_LABEL and OPENBAO_TOKEN must not be the sample values in production.',
    );
  }
  const agentApiUrl = env.AGENT_API_URL ? url(env, 'AGENT_API_URL') : url(env, 'API_PUBLIC_URL');
  const agentChart = env.AGENT_CHART || DEFAULT_AGENT_CHART;
  if (!/^(oci:\/\/|https:\/\/)?[A-Za-z0-9][A-Za-z0-9.:/_-]{0,250}$/.test(agentChart)) {
    throw new InvalidConfigError('AGENT_CHART must be a chart reference, such as oci://registry.example.com/charts/agent.');
  }
  const demoData = env.DEMO_DATA === 'true';
  if (isProduction && demoData) {
    throw new InvalidConfigError('DEMO_DATA is for local use only.');
  }
  if (isProduction) {
    if (!agentApiUrl.startsWith('https://')) {
      throw new InvalidConfigError('AGENT_API_URL must use https in production.');
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
    forgejoPublicUrl,
    blueprintsDir: env.BLUEPRINTS_DIR || DEFAULT_BLUEPRINTS_DIR,
    pipelinesDir: env.PIPELINES_DIR || DEFAULT_PIPELINES_DIR,
    toolsApiUrl: env.TOOLS_API_URL ? url(env, 'TOOLS_API_URL') : url(env, 'API_PUBLIC_URL'),
    webhookSecretKey,
    signingKeySecret,
    buildWorkDir: env.BUILD_WORK_DIR || join(tmpdir(), 'dreamdevops-builds'),
    buildTimeoutMinutes: integer(env, 'BUILD_TIMEOUT_MINUTES', 60),
    imageRunnerLabel,
    agentApiUrl,
    agentChart,
    targetLostAfterSeconds: integer(env, 'TARGET_LOST_AFTER_SECONDS', 180),
    demoData,
    forgejoAdminUsername: required(env, 'FORGEJO_ADMIN_USERNAME'),
    forgejoAdminPassword: required(env, 'FORGEJO_ADMIN_PASSWORD'),
    openbaoUrl,
    openbaoToken,
    targetOpenbaoUrl: env.TARGET_OPENBAO_URL ? url(env, 'TARGET_OPENBAO_URL') : openbaoUrl,
    targetRegistryHost: env.TARGET_REGISTRY_HOST || new URL(forgejoPublicUrl).host,
    targetGitSshUrl: env.TARGET_GIT_SSH_URL || `ssh://git@${new URL(forgejoPublicUrl).hostname}:22`,
    targetGitKnownHosts: env.TARGET_GIT_KNOWN_HOSTS ?? '',
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

/** Keys and secrets must be long enough to resist guessing. */
function secret(env: Environment, name: string): string {
  const value = required(env, name);
  if (value.length < 32) {
    throw new InvalidConfigError(`${name} must be at least 32 characters.`);
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
