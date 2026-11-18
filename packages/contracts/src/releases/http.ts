import type { BuildStatus } from '../builds/http.ts';

/** Releases' HTTP API, as the dashboard sees it. Types and plain values only, so a browser app can use them. */

/** A release starts from develop; a hotfix from main. */
export const RELEASE_KINDS = ['release', 'hotfix'] as const;
export type ReleaseKind = (typeof RELEASE_KINDS)[number];

export type ReleaseStatus = 'open' | 'merged' | 'published';

/** A release candidate: an image of one commit of the release branch. */
export interface ReleaseCandidate {
  readonly number: number;
  readonly commit: string;
  readonly tag: string;
  readonly buildId: string | null;
  readonly buildStatus: BuildStatus | null;
}

export interface ReleaseView {
  readonly id: string;
  readonly kind: ReleaseKind;
  readonly version: string;
  readonly branch: string;
  readonly status: ReleaseStatus;
  /** Newest first. */
  readonly candidates: readonly ReleaseCandidate[];
  readonly mergeBackPullRequest: number | null;
  readonly finalBuildId: string | null;
  readonly finalBuildStatus: BuildStatus | null;
  readonly createdAt: string;
  readonly mergedAt: string | null;
  readonly publishedAt: string | null;
}

/** An application's releases, newest first, with the version each kind would take next. */
export interface ReleasesOverview {
  readonly releases: readonly ReleaseView[];
  readonly suggestions: Readonly<Record<ReleaseKind, string>>;
}

/** Starts a release or a hotfix of a version, such as "1.4.0". */
export interface StartRelease {
  readonly kind: ReleaseKind;
  readonly version: string;
}

export interface StartedRelease {
  readonly id: string;
}

/** How many releases caught up on merges and pushes the platform had missed. */
export interface ReleasesSynced {
  readonly moved: number;
}
