import { GIT_FLOW } from '../../source-governance/domain/git-flow.ts';
import { formatVersion, parseCoreVersion, type Version } from './versions.ts';

/** Where releases and hotfixes end up, and where each hotfix starts. */
export const PRODUCTION_BRANCH = 'main';
/** Where features are merged, and where each release starts. */
export const INTEGRATION_BRANCH = GIT_FLOW.defaultBranch;

export type LineKind = 'release' | 'hotfix';

/** A release or hotfix branch, named after the version it becomes, such as release/1.4.0. */
export interface ReleaseLine {
  readonly kind: LineKind;
  readonly branch: string;
  readonly version: Version;
}

const LINE_BRANCH = /^(release|hotfix)\/(.+)$/;
const FEATURE_BRANCH = /^feature\/[A-Za-z0-9._/-]+$/;

/** Reads a release or hotfix branch name. Any other branch, or a name without a plain version, gives null. */
export function parseLineBranch(branch: string): ReleaseLine | null {
  const match = LINE_BRANCH.exec(branch);
  const version = match?.[2] === undefined ? null : parseCoreVersion(match[2]);
  if (match === null || version === null) {
    return null;
  }
  return { kind: match[1] as LineKind, branch, version };
}

export function lineBranch(kind: LineKind, version: Version): string {
  return `${kind}/${formatVersion(version)}`;
}

/** The branch a release or hotfix starts from. */
export function lineSource(kind: LineKind): string {
  return kind === 'release' ? INTEGRATION_BRANCH : PRODUCTION_BRANCH;
}

export function isFeatureBranch(branch: string): boolean {
  return FEATURE_BRANCH.test(branch) && !branch.includes('..') && branch.length <= 255;
}

export function candidateKind(kind: LineKind): 'release-candidate' | 'hotfix-candidate' {
  return kind === 'release' ? 'release-candidate' : 'hotfix-candidate';
}
