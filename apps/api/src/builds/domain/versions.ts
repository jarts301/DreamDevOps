/**
 * Semantic versions, as image builds use them. Build metadata (+...) isn't allowed,
 * because image tags can't contain "+", and every version is also an image tag.
 */
export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

export type BuildKind = 'development' | 'release-candidate' | 'hotfix-candidate' | 'release';

export const BUILD_KINDS: readonly BuildKind[] = ['development', 'release-candidate', 'hotfix-candidate', 'release'];

/**
 * Whether images of a kind are fit for production. Only releases are: they were merged
 * into main, tagged, and passed every check as what main holds. Candidates and
 * development images are for trying out.
 */
export function isProductive(kind: BuildKind): boolean {
  return kind === 'release';
}

export type Bump = 'major' | 'minor' | 'patch';

const NUMBER = '(0|[1-9]\\d*)';
const IDENTIFIER = '[0-9A-Za-z-]+';
const VERSION_PATTERN = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?$`);
const CORE_PATTERN = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);
/** The longest tag a registry accepts. */
const MAX_TAG_LENGTH = 128;

/** Reads a version, or returns null. Numeric pre-release parts can't have leading zeros. */
export function parseVersion(text: string): Version | null {
  const match = VERSION_PATTERN.exec(text);
  if (match === null || text.length > MAX_TAG_LENGTH) {
    return null;
  }
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    return null;
  }
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return null;
  }
  return { major, minor, patch, prerelease };
}

/** A plain release version, such as 1.4.0, with no pre-release part. */
export function parseCoreVersion(text: string): Version | null {
  return CORE_PATTERN.test(text) ? parseVersion(text) : null;
}

export function formatVersion(version: Version): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length === 0 ? core : `${core}-${version.prerelease.join('.')}`;
}

export function coreVersion(version: Version): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** Orders versions as semantic versioning does: 1.4.0-rc.2 comes before 1.4.0-rc.10 and 1.4.0. */
export function compareVersions(left: Version, right: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) {
      return a === undefined ? -1 : 1;
    }
    if (a === b) {
      continue;
    }
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      return Number(a) - Number(b);
    }
    if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    }
    return a < b ? -1 : 1;
  }
  return 0;
}

/** The next release after a version, or the first one when there's none yet. */
export function bump(version: Version | null, kind: Bump): Version {
  const current = version ?? { major: 0, minor: 0, patch: 0, prerelease: [] };
  switch (kind) {
    case 'major':
      return { major: current.major + 1, minor: 0, patch: 0, prerelease: [] };
    case 'minor':
      return { major: current.major, minor: current.minor + 1, patch: 0, prerelease: [] };
    case 'patch':
      return { major: current.major, minor: current.minor, patch: current.patch + 1, prerelease: [] };
  }
}

export function parseBump(value: unknown): Exclude<Bump, 'patch'> | null {
  return value === 'major' || value === 'minor' ? value : null;
}

/** 1.4.0-rc.2 for the second candidate of release 1.4.0, and 1.3.1-hotfix.1 for a hotfix's first. */
export function candidateVersion(core: Version, kind: 'release-candidate' | 'hotfix-candidate', number: number): Version {
  return { ...core, prerelease: [kind === 'release-candidate' ? 'rc' : 'hotfix', String(number)] };
}

/** 1.5.0-dev.pr12.3 for the third development image of pull request 12, on its way to 1.5.0. */
export function developmentVersion(next: Version, pullRequest: number, number: number): Version {
  return { ...next, prerelease: ['dev', `pr${pullRequest}`, String(number)] };
}

/** The newest of some versions, or null when there are none. */
export function newest(versions: readonly Version[]): Version | null {
  return versions.reduce<Version | null>(
    (best, candidate) => (best === null || compareVersions(candidate, best) > 0 ? candidate : best),
    null,
  );
}
