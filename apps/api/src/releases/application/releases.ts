import { randomUUID } from 'node:crypto';
import { createDomainEvent, currentCompanyId } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { Builds } from '../../builds/application/builds.ts';
import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import type { Principal } from '../../identity-access/domain/access.ts';
import type { RepositorySpec, SourceHost } from '../../source-governance/application/ports.ts';
import type { Repositories } from '../../source-governance/application/repositories.ts';
import { RC_IMAGE_CHECK } from '../../source-governance/domain/git-flow.ts';
import { ReleaseError } from '../domain/errors.ts';
import {
  branchFor,
  formatVersion,
  parseVersion,
  type ReleaseKind,
  refusalFor,
  releaseBranch,
  suggestVersions,
} from '../domain/version.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReleaseStatus = 'open' | 'merged' | 'published';

interface ReleaseRow {
  id: string;
  application_id: string;
  kind: ReleaseKind;
  version: string;
  branch: string;
  status: ReleaseStatus;
  candidates: number;
  last_candidate_commit: string | null;
  merge_commit: string | null;
  merge_back_pull_request: number | null;
  final_build_id: string | null;
  created_at: Date;
  merged_at: Date | null;
  published_at: Date | null;
}

export interface ReleaseView {
  readonly id: string;
  readonly kind: ReleaseKind;
  readonly version: string;
  readonly branch: string;
  readonly status: ReleaseStatus;
  readonly candidates: readonly {
    readonly number: number;
    readonly commit: string;
    readonly tag: string;
    readonly buildId: string | null;
    readonly buildStatus: string | null;
  }[];
  readonly mergeBackPullRequest: number | null;
  readonly finalBuildId: string | null;
  readonly finalBuildStatus: string | null;
  readonly createdAt: string;
  readonly mergedAt: string | null;
  readonly publishedAt: string | null;
}

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
  readonly #database: TenantDatabase;
  readonly #catalog: ApplicationCatalog;
  readonly #repositories: Repositories;
  readonly #source: SourceHost;
  readonly #builds: Builds;

  constructor(
    database: TenantDatabase,
    catalog: ApplicationCatalog,
    repositories: Repositories,
    source: SourceHost,
    builds: Builds,
  ) {
    this.#database = database;
    this.#catalog = catalog;
    this.#repositories = repositories;
    this.#source = source;
    this.#builds = builds;
  }

  async list(applicationIdValue: unknown): Promise<{ releases: ReleaseView[]; suggestions: Record<ReleaseKind, string> }> {
    const application = await this.#catalog.get(applicationIdValue);
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<ReleaseRow & { final_build_status: string | null }>(
        `SELECT r.*, b.status AS final_build_status
         FROM releases.releases r
         LEFT JOIN builds.builds b ON b.id = r.final_build_id
         WHERE r.application_id = $1
         ORDER BY r.created_at DESC`,
        [application.id],
      );
      const { rows: candidates } = await tx.query<{
        release_id: string;
        number: number;
        commit_sha: string;
        tag: string;
        build_id: string | null;
        build_status: string | null;
      }>(
        `SELECT c.*, b.status AS build_status
         FROM releases.candidates c
         JOIN releases.releases r ON r.id = c.release_id
         LEFT JOIN builds.builds b ON b.id = c.build_id
         WHERE r.application_id = $1
         ORDER BY c.number DESC`,
        [application.id],
      );
      return {
        releases: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          version: row.version,
          branch: row.branch,
          status: row.status,
          candidates: candidates
            .filter((candidate) => candidate.release_id === row.id)
            .map((candidate) => ({
              number: candidate.number,
              commit: candidate.commit_sha,
              tag: candidate.tag,
              buildId: candidate.build_id,
              buildStatus: candidate.build_status,
            })),
          mergeBackPullRequest: row.merge_back_pull_request,
          finalBuildId: row.final_build_id,
          finalBuildStatus: row.final_build_status,
          createdAt: row.created_at.toISOString(),
          mergedAt: row.merged_at?.toISOString() ?? null,
          publishedAt: row.published_at?.toISOString() ?? null,
        })),
        suggestions: suggestVersions(rows),
      };
    });
  }

  /** A Tech Lead starts a release from develop, or a hotfix from main. */
  async start(actor: Principal, applicationIdValue: unknown, input: { kind?: unknown; version?: unknown }): Promise<string> {
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
    await this.#database.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('releases:' || $1, 0))", [application.id]);
      const { rows } = await tx.query<{ version: string; kind: ReleaseKind; status: ReleaseStatus }>(
        'SELECT version, kind, status FROM releases.releases WHERE application_id = $1',
        [application.id],
      );
      if (rows.some((row) => row.kind === kind && row.status === 'open')) {
        throw new ReleaseError('conflict', `Another ${kind} is still open. Finish it first.`);
      }
      const refusal = refusalFor(kind, version, rows);
      if (refusal !== null) {
        throw new ReleaseError('conflict', refusal);
      }
      const text = formatVersion(version);
      await tx.query(
        `INSERT INTO releases.releases (id, company_id, application_id, kind, version, branch, status, started_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)`,
        [id, currentCompanyId(), application.id, kind, text, branchFor(kind, text), actor.userId],
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'ReleaseStarted',
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
    const release = await this.#database.transaction((tx) => findRelease(tx, releaseId));
    if (release === null || release.status !== 'open') {
      return;
    }
    const spec = await this.#spec(release.application_id);
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
    const release = await this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<ReleaseRow>(
        "SELECT * FROM releases.releases WHERE application_id = $1 AND branch = $2 AND status = 'open'",
        [payload.applicationId, payload.branch],
      );
      return rows[0] ?? null;
    });
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
    const release = await this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<ReleaseRow>(
        "SELECT * FROM releases.releases WHERE application_id = $1 AND branch = $2 AND status IN ('open', 'merged') FOR UPDATE",
        [payload.applicationId, payload.head],
      );
      const found = rows[0];
      if (found === undefined) {
        return null;
      }
      if (found.status === 'open') {
        await tx.query(
          `UPDATE releases.releases SET status = 'merged', merge_commit = $2, merged_at = now(), updated_at = now()
           WHERE id = $1`,
          [found.id, payload.mergeCommit],
        );
        await appendToOutbox(tx, [
          createDomainEvent({
            eventType: 'ReleaseMerged',
            companyId: currentCompanyId(),
            payload: {
              releaseId: found.id,
              applicationId: found.application_id,
              kind: found.kind,
              version: found.version,
              mergeCommit: payload.mergeCommit,
            },
          }),
        ]);
      }
      return { ...found, merge_commit: found.merge_commit ?? payload.mergeCommit };
    });
    if (release === null) {
      return;
    }
    await this.#source.createTag(spec, `v${release.version}`, release.merge_commit!);
    await this.#buildFinal(release);
    const pullRequest = await this.#source.openPullRequest(spec, {
      head: 'main',
      base: 'develop',
      title: `Merge ${release.version} back into develop`,
      body: `Brings the changes made during the ${release.kind} ${release.version} back into develop, so the next version keeps them.`,
    });
    await this.#database.transaction((tx) =>
      tx.query('UPDATE releases.releases SET merge_back_pull_request = $2, updated_at = now() WHERE id = $1', [
        release.id,
        pullRequest,
      ]),
    );
  }

  /** Reports a candidate's image to the pull request, and publishes the release with its final image. */
  async onBuildFinished(build: FinishedBuild, succeeded: boolean): Promise<void> {
    if (build.releaseId === null) {
      return;
    }
    const release = await this.#database.transaction((tx) => findRelease(tx, build.releaseId!));
    if (release === null) {
      return;
    }
    if (build.kind === 'rc') {
      const spec = await this.#spec(release.application_id);
      await this.#source.setCommitStatus(spec, build.commit, {
        context: RC_IMAGE_CHECK,
        state: succeeded ? 'success' : 'failure',
        description: succeeded ? 'A signed RC image is published.' : `The RC image failed: ${build.reason ?? 'unknown'}`,
      });
      return;
    }
    if (build.kind === 'final' && succeeded) {
      await this.#database.transaction(async (tx) => {
        const { rowCount } = await tx.query(
          `UPDATE releases.releases SET status = 'published', published_at = now(), updated_at = now()
           WHERE id = $1 AND status = 'merged'`,
          [release.id],
        );
        if (rowCount === 1) {
          await appendToOutbox(tx, [
            createDomainEvent({
              eventType: 'ReleasePublished',
              companyId: currentCompanyId(),
              payload: {
                releaseId: release.id,
                applicationId: release.application_id,
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

  /** Builds the final image again, such as after a failure. */
  async rebuildFinal(releaseIdValue: unknown): Promise<void> {
    if (typeof releaseIdValue !== 'string' || !UUID_PATTERN.test(releaseIdValue)) {
      throw new ReleaseError('invalid', 'The release ID is not valid.');
    }
    const release = await this.#database.transaction((tx) => findRelease(tx, releaseIdValue));
    if (release === null) {
      throw new ReleaseError('not-found', 'This release does not exist.');
    }
    if (release.status !== 'merged' || release.merge_commit === null) {
      throw new ReleaseError('conflict', 'Only a merged release that has no final image can be rebuilt.');
    }
    await this.#buildFinal(release);
  }

  async #buildFinal(release: ReleaseRow): Promise<void> {
    const buildId = await this.#builds.request({
      applicationId: release.application_id,
      kind: 'final',
      branch: 'main',
      commit: release.merge_commit!,
      tag: release.version,
      version: release.version,
      releaseId: release.id,
      actorId: null,
    });
    await this.#database.transaction((tx) =>
      tx.query('UPDATE releases.releases SET final_build_id = $2, updated_at = now() WHERE id = $1', [
        release.id,
        buildId,
      ]),
    );
  }

  /** Tags a new commit on the release branch as the next candidate, and builds it. */
  async #candidate(releaseId: string, commit: string, actorId: string | null): Promise<void> {
    const spec = await this.#spec(
      (await this.#database.transaction((tx) => findRelease(tx, releaseId)))!.application_id,
    );
    const created = await this.#database.transaction(async (tx) => {
      const release = await findRelease(tx, releaseId, { lock: true });
      if (release === null || release.status !== 'open' || release.last_candidate_commit === commit) {
        return null;
      }
      const { rows: existing } = await tx.query('SELECT 1 FROM releases.candidates WHERE release_id = $1 AND commit_sha = $2', [
        releaseId,
        commit,
      ]);
      if (existing.length > 0) {
        return null;
      }
      const number = release.candidates + 1;
      const tag = `v${release.version}-rc.${number}`;
      // Tagging first means a failure here leaves nothing recorded, and the retry tags again.
      await this.#source.createTag(spec, tag, commit);
      await tx.query(
        'INSERT INTO releases.candidates (release_id, company_id, number, commit_sha, tag) VALUES ($1, $2, $3, $4, $5)',
        [releaseId, currentCompanyId(), number, commit, tag],
      );
      await tx.query(
        'UPDATE releases.releases SET candidates = $2, last_candidate_commit = $3, updated_at = now() WHERE id = $1',
        [releaseId, number, commit],
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'ReleaseCandidateCreated',
          companyId: currentCompanyId(),
          actorId,
          payload: { releaseId, applicationId: release.application_id, version: release.version, number, tag, commit },
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
      applicationId: created.release.application_id,
      kind: 'rc',
      branch: created.release.branch,
      commit,
      tag: imageTag,
      version: imageTag,
      releaseId,
      actorId,
    });
    await this.#database.transaction((tx) =>
      tx.query('UPDATE releases.candidates SET build_id = $3 WHERE release_id = $1 AND number = $2', [
        releaseId,
        created.number,
        buildId,
      ]),
    );
  }

  async #spec(applicationId: string): Promise<RepositorySpec> {
    const spec = await this.#repositories.locate(applicationId);
    if (spec === null) {
      throw new ReleaseError('conflict', "The application's repository isn't ready.");
    }
    return spec;
  }
}

async function findRelease(tx: TenantTransaction, id: string, options: { lock?: boolean } = {}): Promise<ReleaseRow | null> {
  const { rows } = await tx.query<ReleaseRow>(
    `SELECT * FROM releases.releases WHERE id = $1${options.lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}
