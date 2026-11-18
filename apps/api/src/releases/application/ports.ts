import type { ReleaseStatus } from '@dreamdevops/contracts/releases/http';
import type { EventLog, Transactional } from '@dreamdevops/shared-kernel';
import type { ReleaseKind } from '../domain/version.ts';

/** A release or hotfix, as Releases keeps it. */
export interface StoredRelease {
  readonly id: string;
  readonly applicationId: string;
  readonly kind: ReleaseKind;
  readonly version: string;
  readonly branch: string;
  readonly status: ReleaseStatus;
  /** How many candidates it has had. */
  readonly candidates: number;
  readonly lastCandidateCommit: string | null;
  readonly mergeCommit: string | null;
  readonly mergeBackPullRequest: number | null;
  readonly finalBuildId: string | null;
  readonly createdAt: Date;
  readonly mergedAt: Date | null;
  readonly publishedAt: Date | null;
}

/** A release candidate: one commit of the release branch, tagged, and its image's build. */
export interface StoredCandidate {
  readonly releaseId: string;
  readonly number: number;
  readonly commit: string;
  readonly tag: string;
  readonly buildId: string | null;
}

/** The current company's releases, in one transaction. */
export interface ReleasesSession extends EventLog {
  /** An application's releases, newest first. */
  list(applicationId: string): Promise<StoredRelease[]>;
  /** The candidates of an application's releases, newest first. */
  candidatesOf(applicationId: string): Promise<StoredCandidate[]>;
  /** Lets one release at a time start for an application, so two can't take the same version. */
  lockApplication(applicationId: string): Promise<void>;
  add(release: {
    readonly id: string;
    readonly applicationId: string;
    readonly kind: ReleaseKind;
    readonly version: string;
    readonly branch: string;
    readonly startedBy: string;
  }): Promise<void>;
  /** One release, locked until the transaction ends when asked. */
  find(id: string, options?: { readonly lock?: boolean }): Promise<StoredRelease | null>;
  /** The open release of an application's branch. */
  openOnBranch(applicationId: string, branch: string): Promise<StoredRelease | null>;
  /** The open or merged release of an application's branch, locked. */
  lockUnpublishedOnBranch(applicationId: string, branch: string): Promise<StoredRelease | null>;
  /** Open releases, of one application or every one of the company's. */
  open(applicationId?: string): Promise<StoredRelease[]>;
  /** The companies, of any company, with releases still open. */
  companiesWithOpenReleases(): Promise<string[]>;
  markMerged(id: string, mergeCommit: string): Promise<void>;
  /** Publishes a merged release. False when it isn't merged and unpublished. */
  markPublished(id: string): Promise<boolean>;
  /** The pull request back into develop, or null when there was nothing to merge back. */
  setMergeBackPullRequest(id: string, number: number | null): Promise<void>;
  setFinalBuild(id: string, buildId: string): Promise<void>;
  hasCandidate(releaseId: string, commit: string): Promise<boolean>;
  /** Adds the release's next candidate, which becomes its newest. */
  addCandidate(candidate: { readonly releaseId: string; readonly number: number; readonly commit: string; readonly tag: string }): Promise<void>;
  setCandidateBuild(releaseId: string, number: number, buildId: string): Promise<void>;
}

export const RELEASES_STORE = Symbol('RELEASES_STORE');

export type ReleasesStore = Transactional<ReleasesSession>;
