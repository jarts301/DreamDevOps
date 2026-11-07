import { ReleaseError } from './errors.ts';

export type ReleaseKind = 'release' | 'hotfix';

const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export type Version = readonly [number, number, number];

export function parseVersion(value: unknown): Version {
  const match = typeof value === 'string' ? VERSION.exec(value) : null;
  if (match === null) {
    throw new ReleaseError('invalid', 'Enter a version such as 1.4.0.');
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function formatVersion(version: Version): string {
  return version.join('.');
}

export function compareVersions(left: Version, right: Version): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/**
 * Versions only go up. A release usually raises the minor version, and a hotfix the
 * patch version, so these are offered first.
 */
export function suggestVersion(latest: Version | null, kind: ReleaseKind): string {
  if (latest === null) {
    return kind === 'release' ? '0.1.0' : '0.0.1';
  }
  return formatVersion(kind === 'release' ? [latest[0], latest[1] + 1, 0] : [latest[0], latest[1], latest[2] + 1]);
}

export interface ExistingRelease {
  readonly kind: ReleaseKind;
  readonly version: string;
  readonly status: 'open' | 'merged' | 'published';
}

const shipped = (release: ExistingRelease) => release.status !== 'open';

/**
 * Checks a new release or hotfix version against the application's others. It must be
 * unused and higher than everything merged. A hotfix goes out before an open release, so
 * it must be lower than that release; a release must be higher than an open hotfix.
 * Returns why it's refused, or null.
 */
export function refusalFor(kind: ReleaseKind, version: Version, existing: readonly ExistingRelease[]): string | null {
  const text = formatVersion(version);
  if (existing.some((release) => release.version === text)) {
    return `Version ${text} is already used.`;
  }
  const latest = highest(existing.filter(shipped));
  if (latest !== null && compareVersions(version, latest) <= 0) {
    return `The version must be higher than ${formatVersion(latest)}, the newest merged version.`;
  }
  const other = existing.find((release) => release.status === 'open' && release.kind !== kind);
  if (other !== undefined) {
    const otherVersion = parseVersion(other.version);
    if (kind === 'hotfix' && compareVersions(version, otherVersion) >= 0) {
      return `A hotfix must be lower than the open release ${other.version}.`;
    }
    if (kind === 'release' && compareVersions(version, otherVersion) <= 0) {
      return `A release must be higher than the open hotfix ${other.version}.`;
    }
  }
  return null;
}

/**
 * The versions to offer next: a release raises the minor version of the newest one, open
 * ones included, and a hotfix raises the patch of the newest merged one.
 */
export function suggestVersions(existing: readonly ExistingRelease[]): Record<ReleaseKind, string> {
  return {
    release: suggestVersion(highest(existing), 'release'),
    hotfix: suggestVersion(highest(existing.filter(shipped)), 'hotfix'),
  };
}

function highest(releases: readonly ExistingRelease[]): Version | null {
  return releases
    .map((release) => parseVersion(release.version))
    .reduce<Version | null>((top, version) => (top === null || compareVersions(version, top) > 0 ? version : top), null);
}

/** The branch Git Flow names for a release or hotfix. */
export function branchFor(kind: ReleaseKind, version: string): string {
  return `${kind}/${version}`;
}

/** The release or hotfix a branch belongs to, if any. */
export function releaseBranch(branch: string): { kind: ReleaseKind; version: string } | null {
  const match = /^(release|hotfix)\/(\d+\.\d+\.\d+)$/.exec(branch);
  return match === null ? null : { kind: match[1] as ReleaseKind, version: match[2]! };
}
