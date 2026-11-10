import { isIP } from 'node:net';
import { EnvironmentError } from './errors.ts';

/** Where a provider runs: servers the company runs itself, or a cloud service. */
export type HostingKind = 'self-hosted' | 'cloud';

export type SettingType = 'url' | 'hostname' | 'port' | 'text';

export interface SettingDefinition {
  /** A stable key. Saved settings use it, so it must never change. */
  readonly key: string;
  readonly label: string;
  readonly type: SettingType;
  readonly required: boolean;
  /** For text settings, the form a value must have. */
  readonly pattern?: string;
  /** For optional ports, the value used when none is given. */
  readonly defaultValue?: number;
  readonly example: string;
  readonly help: string | null;
}

/**
 * A kind of place where environments can run. Providers are data: adding one means
 * adding it to HOSTING_PROVIDERS, and the dashboard shows its settings from this.
 */
export interface HostingProvider {
  /** A stable key. Targets and events use it, so it must never change. */
  readonly key: string;
  readonly name: string;
  readonly kind: HostingKind;
  readonly description: string;
  /**
   * Whether the platform can deploy to it yet. Others can be chosen already, so
   * environments can be planned, and will deploy once the platform supports them.
   */
  readonly deploys: boolean;
  readonly settings: readonly SettingDefinition[];
}

export type HostingSettings = Readonly<Record<string, string | number>>;

/** The provider for the machine that runs DreamDevOps, which every company starts with. */
export const LOCAL_PROVIDER = 'local';

/**
 * The providers a company can host environments with. Credentials aren't collected
 * here: when the platform starts setting up infrastructure, they'll be kept in a secret
 * store, never in the database.
 */
export const HOSTING_PROVIDERS: readonly HostingProvider[] = [
  {
    key: LOCAL_PROVIDER,
    name: 'This machine',
    kind: 'self-hosted',
    description: 'Docker on the machine that runs DreamDevOps. Every company has one, and new environments run here unless you choose otherwise.',
    deploys: true,
    settings: [
      {
        key: 'publicHost',
        label: 'Host name for applications',
        type: 'hostname',
        required: false,
        example: 'localhost',
        help: 'The name people use to reach this machine. Each environment gets its own port on it.',
      },
    ],
  },
  {
    key: 'kubernetes',
    name: 'Kubernetes cluster',
    kind: 'self-hosted',
    description: 'A Kubernetes cluster you run, such as k3s on your own servers.',
    deploys: false,
    settings: [
      {
        key: 'apiServerUrl',
        label: 'API server address',
        type: 'url',
        required: true,
        example: 'https://k8s.example.com:6443',
        help: null,
      },
      {
        key: 'ingressDomain',
        label: 'Domain for applications',
        type: 'hostname',
        required: false,
        example: 'apps.example.com',
        help: 'Each environment gets an address under this domain.',
      },
    ],
  },
  {
    key: 'docker',
    name: 'Docker host',
    kind: 'self-hosted',
    description: 'A server you run with Docker, reached over SSH.',
    deploys: false,
    settings: [
      { key: 'host', label: 'Host name or IP address', type: 'hostname', required: true, example: 'docker-01.example.com', help: null },
      { key: 'sshPort', label: 'SSH port', type: 'port', required: false, defaultValue: 22, example: '22', help: null },
    ],
  },
  {
    key: 'aws',
    name: 'Amazon Web Services',
    kind: 'cloud',
    description: 'An AWS account, in one region.',
    deploys: false,
    settings: [
      { key: 'accountId', label: 'Account ID', type: 'text', required: true, pattern: '^\\d{12}$', example: '123456789012', help: '12 digits.' },
      {
        key: 'region',
        label: 'Region',
        type: 'text',
        required: true,
        pattern: '^[a-z]{2}(-gov)?-[a-z]+-\\d$',
        example: 'eu-west-1',
        help: null,
      },
    ],
  },
  {
    key: 'azure',
    name: 'Microsoft Azure',
    kind: 'cloud',
    description: 'An Azure subscription, in one region.',
    deploys: false,
    settings: [
      {
        key: 'subscriptionId',
        label: 'Subscription ID',
        type: 'text',
        required: true,
        pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
        example: '00000000-0000-0000-0000-000000000000',
        help: null,
      },
      { key: 'region', label: 'Region', type: 'text', required: true, pattern: '^[a-z][a-z0-9]{2,30}$', example: 'westeurope', help: null },
    ],
  },
  {
    key: 'gcp',
    name: 'Google Cloud',
    kind: 'cloud',
    description: 'A Google Cloud project, in one region.',
    deploys: false,
    settings: [
      {
        key: 'projectId',
        label: 'Project ID',
        type: 'text',
        required: true,
        pattern: '^[a-z][a-z0-9-]{4,28}[a-z0-9]$',
        example: 'acme-production',
        help: null,
      },
      { key: 'region', label: 'Region', type: 'text', required: true, pattern: '^[a-z]+-[a-z]+\\d+$', example: 'europe-west1', help: null },
    ],
  },
];

export function findProvider(key: unknown): HostingProvider | null {
  return HOSTING_PROVIDERS.find((provider) => provider.key === key) ?? null;
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_TEXT_LENGTH = 200;

/**
 * Checks settings against the provider's definitions and returns them cleaned up.
 * Unknown settings are refused, so nothing unchecked is ever saved.
 */
export function parseSettings(provider: HostingProvider, value: unknown): HostingSettings {
  const input = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const unknown = Object.keys(input).filter((key) => !provider.settings.some((setting) => setting.key === key));
  if (unknown.length > 0) {
    throw new EnvironmentError('invalid', `${provider.name} has no setting named ${unknown.join(', ')}.`);
  }
  const settings: Record<string, string | number> = {};
  for (const definition of provider.settings) {
    const raw = input[definition.key];
    const given = typeof raw === 'string' ? raw.trim() : raw;
    if (given === undefined || given === null || given === '') {
      if (definition.required) {
        throw new EnvironmentError('invalid', `Enter the ${inSentence(definition.label)}.`);
      }
      if (definition.defaultValue !== undefined) {
        settings[definition.key] = definition.defaultValue;
      }
      continue;
    }
    settings[definition.key] = parseSetting(definition, given);
  }
  return settings;
}

/** A label inside a sentence: "Account ID" becomes "account ID", and "API server address" stays as it is. */
function inSentence(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label;
}

function parseSetting(definition: SettingDefinition, value: unknown): string | number {
  const refuse = (): never => {
    throw new EnvironmentError('invalid', `The ${inSentence(definition.label)} isn't valid. For example: ${definition.example}.`);
  };
  if (definition.type === 'port') {
    const port = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : NaN;
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : refuse();
  }
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) {
    return refuse();
  }
  switch (definition.type) {
    case 'url': {
      if (!URL.canParse(value)) {
        return refuse();
      }
      const url = new URL(value);
      // Addresses are for machines the platform will reach, so they must be encrypted and hold no password.
      return url.protocol === 'https:' && url.username === '' && url.password === '' ? value.replace(/\/$/, '') : refuse();
    }
    case 'hostname': {
      const host = value.toLowerCase();
      return HOSTNAME.test(host) || isIP(host) !== 0 ? host : refuse();
    }
    case 'text':
      return new RegExp(definition.pattern ?? '^.+$').test(value) ? value : refuse();
  }
}
