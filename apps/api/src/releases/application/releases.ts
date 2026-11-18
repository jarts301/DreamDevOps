import { randomUUID } from 'node:crypto';
import type { BuildRequests } from '@dreamdevops/contracts/builds/services';
import type { ApplicationDirectory } from '@dreamdevops/contracts/catalog/services';
import type { Principal } from '@dreamdevops/contracts/identity-access/access';
import type { ReleasesOverview, StartRelease } from '@dreamdevops/contracts/releases/http';
import { ReleaseCandidateCreated, ReleaseMerged, ReleasePublished, ReleaseStarted } from '@dreamdevops/contracts/releases/events';
import type { Unchecked } from '@dreamdevops/contracts/http';
import {
  RC_IMAGE_CHECK,
  type RepositoryGit,
  type RepositoryLookup,
  type RepositorySpec,
} from '@dreamdevops/contracts/source-governance/services';
import { currentCompanyId, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { ReleaseError } from '../domain/errors.ts';
import { branchFor, formatVersion, parseVersion, refusalFor, releaseBranch, suggestVersions } from '../domain/version.ts';
import type { ReleasesStore, StoredRelease } from './ports.ts';

const NO_COMPANY = parseCompanyId('00000000-0000-0000-0000-000000000000');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a finished build tells this module. */
export interface FinishedBuild {
  readonly buildId: string;
  readonly kind: string;
  readonly commit: string;
  readonly releaseId: string | null;
  readonly reason?: string;
}

/**
 * Runs Git Flow releases and hotfixes: cuts the branch, tags and builds a release
 * candidate for each new commit, reports whether the newest one has an image so the
 * pull request into main can merge, then tags the merge, builds the final image and
 * opens the pull request back into develop.
 */
export class Releases {
  readonly #store: ReleasesStore;
  readonly #catalog: ApplicationDirectory;
  readonly #repositories: RepositoryLookup;
  readonly #source: RepositoryGit;
  readonly #builds: BuildRequests;

  constructor(
    store: ReleasesStore,
    catalog: ApplicationDirectory,
    repositories: RepositoryLookup,
    source: RepositoryGit,
    builds: BuildRequests,
  ) {
    this.#store = store;
    this.#catalog = catalog;
    this.#repositories = repositories;
    this.#source = source;
    this.#builds = builds;
  }

  async list(applicationIdValue: unknown): Promise<ReleasesOverview> {
    const application = await this.#catalog.get(applicationIdValue);
    const { rows, candidates } = await this.#store.transaction(async (session) => ({
      rows: await session.list(application.id),
      candidates: await session.candidatesOf(application.id),
    }));
    // Build statuses come from BuildRequests, which owns them.
    const statuses = await this.#builds.statuses(
      [...rows.map((row) => row.finalBuildId), ...candidates.map((candidate) => candidate.buildId)].filter(
        (id): id is string => id !== null,
      ),
    );
    const statusOf = (id: string | null) => (id === null ? null : (statuses.get(id) ?? null));
    return {
      releases: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        version: row.version,
        branch: row.branch,
        status: row.status,
        candidates: candidates
          .filter((candidate) => candidate.releaseId === row.id)
          .map((candidate) => ({
            number: candidate.number,
            commit: candidate.commit,
            tag: candidate.tag,
            buildId: candidate.buildId,
            buildStatus: statusOf(candidate.buildId),
          })),
        mergeBackPullRequest: row.mergeBackPullRequest,
        finalBuildId: row.finalBuildId,
        finalBuildStatus: statusOf(row.finalBuildId),
        createdAt: row.createdAt.toISOString(),
        mergedAt: row.mergedAt?.toISOString() ?? null,
        publishedAt: row.publishedAt?.toISOString() ?? null,
      })),
      suggestions: suggestVersions(rows),
    };
  }

  /** A Tech Lead starts a release from develop, or a hotfix from main. */
  async start(actor: Principal, applicationIdValue: unknown, input: Unchecked<StartRelease>): Promise<string> {
    const application = await this.#catalog.get(applicationIdValue);
    if (application.status === 'archived') {
      throw new ReleaseError('conflict', 'Restore the application first.');
    }
    if (input.kind !== 'release' && input.kind !== 'hotfix') {
      throw new ReleaseError('invalid', 'Choose a release or a hotfix.');
    }
    const kind = input.kind;
    const version = parseVersion(input.version);
    if ((await this.#repositories.locate(application.id)) === null) {
      throw new ReleaseError('conflict', "The application's repository isn't ready yet.");
    }
    const id = randomUUID();
    await this.#store.transaction(async (session) => {
      await session.lockApplication(application.id);
      const rows = await session.list(application.id);
      if (rows.some((row) => row.kind === kind && row.status === 'open')) {
        throw new ReleaseError('conflict', `Another ${kind} is still open. Finish it first.`);
      }
      const refusal = refusalFor(kind, version, rows);
      if (refusal !== null) {
        throw new ReleaseError('conflict', refusal);
      }
      const text = formatVersion(version);
      await session.add({ id, applicationId: application.id, kind, version: text, branch: branchFor(kind, text), startedBy: actor.userId });
      await session.record([
        ReleaseStarted.create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { releaseId: id, applicationId: application.id, kind, version: text, branch: branchFor(kind, text) },
        }),
      ]);
    });
    return id;
  }

  /** Cuts the release branch and builds its first candidate. Safe to repeat. */
  async prepare(releaseId: string): Promise<void> {
    const release = await this.#store.transaction((session) => session.find(releaseId));
    if (release === null || release.status !== 'open') {
      return;
    }
    const spec = await this.#spec(release.applicationId);
    const head = await this.#source.createBranch(spec, release.branch, release.kind === 'release' ? 'develop' : 'main');
    await this.#candidate(release.id, head, null);
    // The platform opens the pull request into main, so any Tech Lead can approve it: Forgejo
    // doesn't let people approve their own.
    await this.#source.openPullRequest(spec, {
      head: release.branch,
      base: 'main',
      title: `${release.kind === 'release' ? 'Release' : 'Hotfix'} ${release.version}`,
      body: `Merges the ${release.kind} ${release.version} into main. It can merge once a Tech Lead approves, the tests pass, and the newest commit has a published RC image.`,
    });
  }

  /** A push to an open release branch makes a new candidate. */
  async onCodePushed(payload: { applicationId: string; branch: string; after: string }): Promise<void> {
    if (releaseBranch(payload.branch) === null) {
      return;
    }
    const release = await this.#store.transaction((session) => session.openOnBranch(payload.applicationId, payload.branch));
    if (release !== null) {
      await this.#candidate(release.id, payload.after, null);
    }
  }

  /** The merge into main tags the version, builds the final image and opens the merge back. */
  async onPullRequestMerged(payload: {
    applicationId: string;
    head: string;
    base: string;
    mergeCommit: string;
  }): Promise<void> {
    if (payload.base !== 'main' || releaseBranch(payload.head) === null) {
      return;
    }
    const spec = await this.#spec(payload.applicationId);
    const release = await this.#store.transaction(async (session) => {
      const found = await session.lockUnpublishedOnBranch(payload.applicationId, payload.head);
      if (found === null) {
        return null;
      }
      if (found.status === 'open') {
        await session.markMerged(found.id, payload.mergeCommit);
        await session.record([
          ReleaseMerged.create({
            companyId: currentCompanyId(),
            payload: {
              releaseId: found.id,
              applicationId: found.applicationId,
              kind: found.kind,
              version: found.version,
              mergeCommit: payload.mergeCommit,
            },
          }),
        ]);
      }
      return { ...found, mergeCommit: found.mergeCommit ?? payload.mergeCommit };
    });
    if (release === null) {
      return;
    }
    await this.#source.createTag(spec, `v${release.version}`, release.mergeCommit!);
    await this.#buildFinal(release);
    const pullRequest = await this.#source.openPullRequest(spec, {
      head: 'main',
      base: 'develop',
      title: `Merge ${release.version} back into develop`,
      body: `Brings the changes made during the ${release.kind} ${release.version} back into develop, so the next version keeps them.`,
    });
    await this.#store.transaction((session) => session.setMergeBackPullRequest(release.id, pullRequest));
  }

  /** Reports a candidate's image to the pull request, and publishes the release with its final image. */
  async onBuildFinished(build: FinishedBuild, succeeded: boolean): Promise<void> {
    if (build.releaseId === null) {
      return;
    }
    const release = await this.#store.transaction((session) => session.find(build.releaseId!));
    if (release === null) {
      return;
    }
    if (build.kind === 'rc') {
      const spec = await this.#spec(release.applicationId);
      await this.#source.setCommitStatus(spec, build.commit, {
        context: RC_IMAGE_CHECK,
        state: succeeded ? 'success' : 'failure',
        description: succeeded ? 'A signed RC image is published.' : `The RC image failed: ${build.reason ?? 'unknown'}`,
      });
      return;
    }
    if (build.kind === 'final' && succeeded) {
      await this.#store.transaction(async (session) => {
        if (await session.markPublished(release.id)) {
          await session.record([
            ReleasePublished.create({
              companyId: currentCompanyId(),
              payload: {
                releaseId: release.id,
                applicationId: release.applicationId,
                kind: release.kind,
                version: release.version,
                buildId: build.buildId,
              },
            }),
          ]);
        }
      });
    }
  }

  /**
   * Catches up on what the Git tool said while the platform wasn't listening, such as
   * while the API was stopped: Forgejo doesn't send a missed webhook again. A release
   * merged into main is finished, and a newer commit on a release branch builds a
   * candidate. Returns how many releases moved on. Safe to repeat.
   */
  async sync(applicationIdValue: unknown): Promise<number> {
    const application = await this.#catalog.get(applicationIdValue);
    const releases = await this.#store.transaction((session) => session.open(application.id));
    let moved = 0;
    for (const release of releases) {
      if (await this.#syncRelease(release)) {
        moved += 1;
      }
    }
    return moved;
  }

  /**
   * Catches up on every company's open releases. Runs in the background. A release the
   * Git tool can't answer for is passed to onError and doesn't hold up the others.
   */
  async syncAll(onError: (error: unknown) => void): Promise<void> {
    const companies = await runWithCompany(NO_COMPANY, () => this.#store.transaction((session) => session.companiesWithOpenReleases()));
    for (const companyId of companies) {
      await runWithCompany(parseCompanyId(companyId), async () => {
        const releases = await this.#store.transaction((session) => session.open());
        for (const release of releases) {
          await this.#syncRelease(release).catch(onError);
        }
      });
    }
  }

  async #syncRelease(release: StoredRelease): Promise<boolean> {
    const spec = await this.#repositories.locate(release.applicationId);
    if (spec === null) {
      return false;
    }
    const merge = await this.#source.findPullRequest(spec, release.branch, 'main');
    if (merge?.merged === true && merge.mergeCommit !== null) {
      await this.onPullRequestMerged({
        applicationId: release.applicationId,
        head: release.branch,
        base: 'main',
        mergeCommit: merge.mergeCommit,
      });
      return true;
    }
    const head = await this.#source.branchHead(spec, release.branch);
    if (head !== null && head !== release.lastCandidateCommit) {
      await this.#candidate(release.id, head, null);
      return true;
    }
    return false;
  }

  /** BuildRequests the final image again, such as after a failure. */
  async rebuildFinal(releaseIdValue: unknown): Promise<void> {
    if (typeof releaseIdValue !== 'string' || !UUID_PATTERN.test(releaseIdValue)) {
      throw new ReleaseError('invalid', 'The release ID is not valid.');
    }
    const release = await this.#store.transaction((session) => session.find(releaseIdValue));
    if (release === null) {
      throw new ReleaseError('not-found', 'This release does not exist.');
    }
    if (release.status !== 'merged' || release.mergeCommit === null) {
      throw new ReleaseError('conflict', 'Only a merged release that has no final image can be rebuilt.');
    }
    await this.#buildFinal(release);
  }

  async #buildFinal(release: StoredRelease): Promise<void> {
    const buildId = await this.#builds.request({
      applicationId: release.applicationId,
      kind: 'final',
      branch: 'main',
      commit: release.mergeCommit!,
      tag: release.version,
      version: release.version,
      releaseId: release.id,
      actorId: null,
    });
    await this.#store.transaction((session) => session.setFinalBuild(release.id, buildId));
  }

  /** Tags a new commit on the release branch as the next candidate, and builds it. */
  async #candidate(releaseId: string, commit: string, actorId: string | null): Promise<void> {
    const spec = await this.#spec((await this.#store.transaction((session) => session.find(releaseId)))!.applicationId);
    const created = await this.#store.transaction(async (session) => {
      const release = await session.find(releaseId, { lock: true });
      if (release === null || release.status !== 'open' || release.lastCandidateCommit === commit) {
        return null;
      }
      if (await session.hasCandidate(releaseId, commit)) {
        return null;
      }
      const number = release.candidates + 1;
      const tag = `v${release.version}-rc.${number}`;
      // Tagging first means a failure here leaves nothing recorded, and the retry tags again.
      await this.#source.createTag(spec, tag, commit);
      await session.addCandidate({ releaseId, number, commit, tag });
      await session.record([
        ReleaseCandidateCreated.create({
          companyId: currentCompanyId(),
          actorId,
          payload: { releaseId, applicationId: release.applicationId, version: release.version, number, tag, commit },
        }),
      ]);
      return { release, number, tag };
    });
    if (created === null) {
      return;
    }
    await this.#source.setCommitStatus(spec, commit, {
      context: RC_IMAGE_CHECK,
      state: 'pending',
      description: `Building the ${created.tag} image.`,
    });
    const imageTag = `${created.release.version}-rc.${created.number}`;
    const buildId = await this.#builds.request({
      applicationId: created.release.applicationId,
      kind: 'rc',
      branch: created.release.branch,
      commit,
      tag: imageTag,
      version: imageTag,
      releaseId,
      actorId,
    });
    await this.#store.transaction((session) => session.setCandidateBuild(releaseId, created.number, buildId));
  }

  async #spec(applicationId: string): Promise<RepositorySpec> {
    const spec = await this.#repositories.locate(applicationId);
    if (spec === null) {
      throw new ReleaseError('conflict', "The application's repository isn't ready.");
    }
    return spec;
  }
}
