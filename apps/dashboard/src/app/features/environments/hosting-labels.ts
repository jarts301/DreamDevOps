import type { HostingKind, HostingProvider, HostingSettings } from './environments.api';

const KIND_NAMES: Readonly<Record<HostingKind, string>> = { 'self-hosted': 'Self-hosted', cloud: 'Cloud' };

export function kindName(kind: HostingKind | null): string {
  return kind === null ? 'No longer offered' : KIND_NAMES[kind];
}

/** A target's settings, labelled as its provider labels them, such as "Region: eu-west-1". */
export function describeSettings(provider: HostingProvider | undefined, settings: HostingSettings): string[] {
  return Object.entries(settings).map(([key, value]) => {
    const label = provider?.settings.find((setting) => setting.key === key)?.label ?? key;
    return `${label}: ${String(value)}`;
  });
}
