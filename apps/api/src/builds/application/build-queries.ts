import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import type { RepositoryLookup } from '../../source-governance/application/repository-lookup.ts';
import type { LineKind } from '../domain/branches.ts';
import { BuildError } from '../domain/errors.ts';
import { bump, formatVersion } from '../domain/versions.ts';
import {
  type BuildRow,
  type BuildView,
  findBuild,
  parseBuildId,
  readyRepository,
  SELECT_BUILDS,
  toView,
  VersionHistory,
} from './build-records.ts';
import { branchExists, callGit, developmentProblem } from './git-rules.ts';
import type { BuildSource } from './ports.ts';

const LIST_LIMIT = 50;

export interface VersionsView {
  /** The newest version merged into main, even if its build failed. */
  readonly onMain: string | null;
  /** The newest release that was published and signed. */
  readonly published: string | null;
  readonly next: { readonly minor: string; readonly major: string; readonly hotfix: string | null };
  readonly lines: readonly {
    readonly kind: LineKind;
    readonly branch: string;
    readonly version: string;
    readonly latestCandidate: { readonly id: string; readonly version: string; readonly status: string } | null;
  }[];
}

export interface PullRequestView {
  readonly number: number;
  readonly title: string;
  readonly branch: string;
  readonly url: string;
  readonly commit: string;
  readonly latestBuild: { readonly id: string; readonly version: string; readonly status: string; readonly commit: string } | null;
}

/**
 * What people can see of builds: each application's builds with their progress, its
 * versions, and the pull requests that can have development images. Nothing here
 * changes anything.
 */
export class BuildQueries {
  readonly #database: TenantDatabase;
  readonly #catalog: ApplicationCatalog;
  readonly #repositories: RepositoryLookup;
  readonly #source: BuildSource;

  constructor(database: TenantDatabase, catalog: ApplicationCatalog, repositories: RepositoryLookup, source: BuildSource) {
    this.#database = database;
    this.#catalog = catalog;
    this.#repositories = repositories;
    this.#source = source;
  }

  /** An application's builds, newest first. */
  async list(applicationId: unknown): Promise<BuildView[]> {
    const application = await this.#catalog.get(applicationId);
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<BuildRow>(
        `${SELECT_BUILDS} WHERE b.application_id = $1 ORDER BY b.number DESC LIMIT ${LIST_LIMIT}`,
        [application.id],
      );
      return rows.map(toView);
    });
  }

  async get(buildId: unknown): Promise<BuildView> {
    const id = parseBuildId(buildId);
    return this.#database.transaction(async (tx) => {
      const row = await findBuild(tx, id);
      if (row === null) {
        throw new BuildError('not-found', 'This build does not exist.');
      }
      return toView(row);
    });
  }

  /**
   * The application's versions: what's released, what's in progress and what comes next.
   * A release or hotfix whose branch was deleted was abandoned, so it isn't in progress.
   */
  async versions(applicationId: unknown): Promise<VersionsView> {
    const application = await this.#catalog.get(applicationId);
    const { history, repository } = await this.#database.transaction(async (tx) => ({
      history: await VersionHistory.load(tx, application.id),
      repository: await readyRepository(this.#repositories, application.id).catch(() => null),
    }));
    const onMain = history.onMain();
    const published = history.published();
    const lines = [];
    for (const line of history.openLines()) {
      if (repository === null || (await branchExists(this.#source, repository, line.branch))) {
        lines.push(line);
      }
    }
    return {
      onMain: onMain === null ? null : formatVersion(onMain),
      published: published === null ? null : formatVersion(published),
      next: {
        minor: formatVersion(bump(onMain, 'minor')),
        major: formatVersion(bump(onMain, 'major')),
        hotfix: onMain === null ? null : formatVersion(bump(onMain, 'patch')),
      },
      lines: lines.map((line) => {
        const latest = line.candidates[0];
        return {
          kind: line.kind,
          branch: line.branch,
          version: formatVersion(line.version),
          latestCandidate: latest === undefined ? null : { id: latest.id, version: latest.version, status: latest.status },
        };
      }),
    };
  }

  /** Open pull requests from feature branches, which can have development images. */
  async pullRequests(applicationId: unknown): Promise<PullRequestView[]> {
    const application = await this.#catalog.get(applicationId);
    const { repository, history } = await this.#database.transaction(async (tx) => ({
      repository: await readyRepository(this.#repositories, application.id),
      history: await VersionHistory.load(tx, application.id),
    }));
    const pullRequests = await callGit(() => this.#source.pullRequests(repository, 'open'));
    return pullRequests
      .filter((pullRequest) => developmentProblem(pullRequest, repository) === null)
      .map((pullRequest) => {
        const latest = history.rows.find((row) => row.kind === 'development' && row.pull_request === pullRequest.number);
        return {
          number: pullRequest.number,
          title: pullRequest.title,
          branch: pullRequest.head.branch,
          url: pullRequest.url,
          commit: pullRequest.head.commit,
          latestBuild:
            latest === undefined
              ? null
              : { id: latest.id, version: latest.version, status: latest.status, commit: latest.commit_sha },
        };
      });
  }
}
