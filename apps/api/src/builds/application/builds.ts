import { randomUUID } from 'node:crypto';
import { createDomainEvent, currentCompanyId } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { ApplicationCatalog, ApplicationView } from '../../catalog/application/application-catalog.ts';
import { hasPermissions, type Principal } from '../../identity-access/domain/access.ts';
import type { RepositoryLookup } from '../../source-governance/application/repository-lookup.ts';
import {
  candidateKind,
  type LineKind,
  lineBranch,
  lineSource,
  parseLineBranch,
  PRODUCTION_BRANCH,
} from '../domain/branches.ts';
import { BuildError } from '../domain/errors.ts';
import { initialSteps } from '../domain/pipeline.ts';
import {
  bump,
  type BuildKind,
  candidateVersion,
  developmentVersion,
  formatVersion,
  parseBump,
  type Version,
} from '../domain/versions.ts';
import { webhookSecret } from '../domain/webhook-signature.ts';
import {
  type BuildView,
  findBuild,
  insertBuild,
  lockApplication,
  parseBuildId,
  queuedEvent,
  readyRepository,
  toView,
  VersionHistory,
} from './build-records.ts';
import { callGit, developmentProblem } from './git-rules.ts';
import type { BuildSource, PullRequest, RepositoryRef } from './ports.ts';

/** Developers and Tech Leads build images of their feature branches. */
export const BUILD_FEATURE_IMAGES = 'feature-images:build';
/** Tech Leads start releases and hotfixes, and build their candidates. */
export const START_RELEASES = 'releases:start';

export interface BuildsOptions {
  /** Where Forgejo sends webhooks, which must reach this API. */
  readonly webhookUrl: string;
  /** The master secret each repository's webhook secret is made from. */
  readonly webhookSecret: string;
}

/**
 * Decides which images get built, and with which version. Builds come from four places:
 *
 * - A developer asks for a development image of a feature branch's open pull request.
 * - Starting a release or hotfix creates its branch, which builds its first candidate.
 * - A release or hotfix branch merged into main builds the release itself.
 * - A Tech Lead asks for a new candidate after more changes reach a release branch.
 *
 * The pipeline that builds each one runs in the background, and what people can see of
 * builds comes from BuildQueries.
 */
export class Builds {
  readonly #database: TenantDatabase;
  readonly #catalog: ApplicationCatalog;
  readonly #repositories: RepositoryLookup;
  readonly #source: BuildSource;
  readonly #options: BuildsOptions;

  constructor(
    database: TenantDatabase,
    catalog: ApplicationCatalog,
    repositories: RepositoryLookup,
    source: BuildSource,
    options: BuildsOptions,
  ) {
    this.#database = database;
    this.#catalog = catalog;
    this.#repositories = repositories;
    this.#source = source;
    this.#options = options;
  }

  /** Builds a development image of an open pull request from a feature branch, at its latest commit. */
  async requestDevelopmentBuild(actor: Principal, applicationId: unknown, numberValue: unknown): Promise<BuildView> {
    const number = parsePullRequestNumber(numberValue);
    const application = await this.#activeApplication(applicationId);
    const repository = await readyRepository(this.#repositories, application.id);
    const pullRequest = await callGit(() => this.#source.pullRequest(repository, number));
    if (pullRequest === null) {
      throw new BuildError('not-found', `Pull request #${number} does not exist.`);
    }
    const problem = developmentProblem(pullRequest, repository);
    if (problem !== null) {
      throw new BuildError('invalid', problem);
    }

    return this.#database.transaction(async (tx) => {
      await lockApplication(tx, application.id);
      const history = await VersionHistory.load(tx, application.id);
      const sameCommit = history.rows.find(
        (row) =>
          row.kind === 'development' &&
          row.pull_request === number &&
          row.commit_sha === pullRequest.head.commit &&
          row.status !== 'failed',
      );
      if (sameCommit !== undefined) {
        throw new BuildError(
          'conflict',
          sameCommit.status === 'succeeded'
            ? `This commit already has a development image: ${sameCommit.version}.`
            : `This commit is already being built as ${sameCommit.version}.`,
        );
      }
      const version = developmentVersion(
        bump(history.onMain(), 'minor'),
        number,
        history.count((row) => row.kind === 'development' && row.pull_request === number) + 1,
      );
      const id = await insertBuild(tx, {
        applicationId: application.id,
        applicationName: application.name,
        kind: 'development',
        version,
        branch: pullRequest.head.branch,
        pullRequest: number,
        commit: pullRequest.head.commit,
        trigger: `requested:${randomUUID()}`,
        requestedBy: actor.userId,
      });
      return toView((await findBuild(tx, id))!);
    });
  }

  /**
   * Starts a release: creates release/<version> from develop, which builds its first
   * candidate. Only one release can be in progress at a time.
   */
  startRelease(actor: Principal, applicationId: unknown, bumpValue: unknown): Promise<BuildView> {
    const kind = parseBump(bumpValue);
    if (kind === null) {
      throw new BuildError('invalid', 'Choose a minor or major release.');
    }
    return this.#startLine(actor, applicationId, 'release', (onMain) => bump(onMain, kind));
  }

  /** Starts a hotfix: creates hotfix/<version> from main, which builds its first candidate. */
  startHotfix(actor: Principal, applicationId: unknown): Promise<BuildView> {
    return this.#startLine(actor, applicationId, 'hotfix', (onMain) => {
      if (onMain === null) {
        throw new BuildError('conflict', 'Release a version before starting a hotfix.');
      }
      return bump(onMain, 'patch');
    });
  }

  /** Builds a new candidate from the latest commit of a release or hotfix branch in progress. */
  async requestCandidate(actor: Principal, applicationId: unknown, branchValue: unknown): Promise<BuildView> {
    const line = typeof branchValue === 'string' ? parseLineBranch(branchValue) : null;
    if (line === null) {
      throw new BuildError('invalid', 'Choose a release or hotfix branch, such as release/1.4.0.');
    }
    const application = await this.#activeApplication(applicationId);
    return this.#database.transaction(async (tx) => {
      const repository = await readyRepository(this.#repositories, application.id);
      await lockApplication(tx, application.id);
      const history = await VersionHistory.load(tx, application.id);
      const open = history.openLines().find((candidate) => candidate.branch === line.branch);
      if (open === undefined) {
        throw new BuildError('conflict', `${line.branch} isn't a release or hotfix in progress.`);
      }
      const head = await callGit(() => this.#source.branch(repository, line.branch));
      if (head === null) {
        throw new BuildError('conflict', `The branch ${line.branch} no longer exists.`);
      }
      const latest = open.candidates[0];
      if (latest !== undefined && latest.commit_sha === head.commit && latest.status !== 'failed') {
        throw new BuildError('conflict', `${latest.version} already covers the latest commit of ${line.branch}.`);
      }
      const id = await this.#insertCandidate(tx, application, history, line.kind, line.version, line.branch, head.commit, {
        trigger: `requested:${randomUUID()}`,
        requestedBy: actor.userId,
      });
      return toView((await findBuild(tx, id))!);
    });
  }

  /** Runs a failed build again, from the start, with the same version and commit. */
  async retry(actor: Principal, buildId: unknown): Promise<BuildView> {
    const id = parseBuildId(buildId);
    return this.#database.transaction(async (tx) => {
      const row = await findBuild(tx, id);
      if (row === null) {
        throw new BuildError('not-found', 'This build does not exist.');
      }
      const permission = row.kind === 'development' ? BUILD_FEATURE_IMAGES : START_RELEASES;
      if (!hasPermissions(actor, [permission])) {
        throw new BuildError('forbidden', 'You do not have permission to do this.');
      }
      if (row.status !== 'failed') {
        throw new BuildError('conflict', 'Only a failed build can be tried again.');
      }
      const application = await this.#activeApplication(row.application_id);
      await tx.query(
        `UPDATE builds.builds
         SET status = 'queued', attempts = 0, last_error = NULL, steps = $2, image = NULL, digest = NULL,
             started_at = NULL, finished_at = NULL, updated_at = now()
         WHERE id = $1`,
        [id, JSON.stringify(initialSteps(row.kind))],
      );
      await appendToOutbox(tx, [
        queuedEvent(actor.userId, {
          buildId: id,
          applicationId: row.application_id,
          name: application.name,
          kind: row.kind,
          version: row.version,
          branch: row.branch,
          pullRequest: row.pull_request,
          retry: true,
        }),
      ]);
      return toView((await findBuild(tx, id))!);
    });
  }

  /**
   * Looks for release and hotfix branches merged into main without the platform hearing
   * about it, such as while the API was stopped, and builds their releases. Returns how
   * many it found.
   */
  async reconcile(applicationId: unknown): Promise<number> {
    const application = await this.#catalog.get(applicationId);
    const { repository, lines } = await this.#database.transaction(async (tx) => ({
      repository: await readyRepository(this.#repositories, application.id),
      lines: (await VersionHistory.load(tx, application.id)).openLines(),
    }));
    if (lines.length === 0 || application.status !== 'active') {
      return 0;
    }
    const closed = await callGit(() => this.#source.pullRequests(repository, 'closed'));
    let found = 0;
    for (const line of lines) {
      const merge = closed.find(
        (pullRequest) =>
          pullRequest.merged && pullRequest.head.branch === line.branch && pullRequest.base.branch === PRODUCTION_BRANCH,
      );
      if (merge !== undefined && (await this.#recordRelease(application, merge))) {
        found += 1;
      }
    }
    return found;
  }

  /** A branch was created in the application's repository. Release and hotfix branches build a candidate. */
  async branchCreated(applicationId: string, branch: string, commit: string): Promise<void> {
    const line = parseLineBranch(branch);
    const application = await this.#catalog.get(applicationId);
    if (line === null || application.status !== 'active' || !isCommit(commit)) {
      return;
    }
    await this.#database.transaction(async (tx) => {
      await lockApplication(tx, application.id);
      const history = await VersionHistory.load(tx, application.id);
      await this.#insertCandidate(tx, application, history, line.kind, line.version, branch, commit, {
        trigger: createdTrigger(branch, commit),
        requestedBy: null,
      });
    });
  }

  /** A pull request was merged. A release or hotfix branch merged into main builds the release. */
  async pullRequestMerged(applicationId: string, pullRequest: PullRequest): Promise<void> {
    const application = await this.#catalog.get(applicationId);
    if (application.status === 'active') {
      await this.#recordRelease(application, pullRequest);
    }
  }

  /** Creates the webhook that tells the platform about new branches and merges, or brings it up to date. */
  async ensureWebhook(applicationId: string): Promise<void> {
    const repository = await readyRepository(this.#repositories, applicationId);
    await this.#source.ensureWebhook(repository, this.#hook(repository));
  }

  #hook(repository: RepositoryRef): { url: string; secret: string } {
    return {
      url: this.#options.webhookUrl,
      secret: webhookSecret(this.#options.webhookSecret, repository.organization, repository.name),
    };
  }

  async #startLine(
    actor: Principal,
    applicationId: unknown,
    kind: LineKind,
    versionFrom: (onMain: Version | null) => Version,
  ): Promise<BuildView> {
    const application = await this.#activeApplication(applicationId);
    return this.#database.transaction(async (tx) => {
      const repository = await readyRepository(this.#repositories, application.id);
      await lockApplication(tx, application.id);
      const history = await VersionHistory.load(tx, application.id);
      for (const line of history.openLines().filter((candidate) => candidate.kind === kind)) {
        // A branch that's gone was abandoned, so it doesn't block a new one.
        if ((await callGit(() => this.#source.branch(repository, line.branch))) !== null) {
          throw new BuildError(
            'conflict',
            `${kind === 'release' ? 'Release' : 'Hotfix'} ${formatVersion(line.version)} is already in progress on ${line.branch}. Finish it first.`,
          );
        }
      }
      const version = versionFrom(history.onMain());
      const branch = lineBranch(kind, version);
      // The webhook reports the merge into main later, so it must exist before the branch does.
      await callGit(() => this.#source.ensureWebhook(repository, this.#hook(repository)));
      const created = await callGit(() => this.#source.createBranch(repository, branch, lineSource(kind)));
      const trigger = createdTrigger(branch, created.commit);
      // Starting the same line again, such as after a timeout, returns what the first attempt started.
      const existing = history.byTrigger(trigger);
      if (existing !== undefined) {
        return toView((await findBuild(tx, existing.id))!);
      }
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: kind === 'release' ? 'ReleaseStarted' : 'HotfixStarted',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { applicationId: application.id, name: application.name, version: formatVersion(version), branch },
        }),
      ]);
      const id = await this.#insertCandidate(tx, application, history, kind, version, branch, created.commit, {
        trigger,
        requestedBy: actor.userId,
      });
      return toView((await findBuild(tx, id))!);
    });
  }

  /** Saves a candidate, unless one was already saved for the same trigger. Call it under lockApplication. */
  async #insertCandidate(
    tx: TenantTransaction,
    application: ApplicationView,
    history: VersionHistory,
    kind: LineKind,
    core: Version,
    branch: string,
    commit: string,
    request: { trigger: string; requestedBy: string | null },
  ): Promise<string> {
    const existing = history.byTrigger(request.trigger);
    if (existing !== undefined) {
      return existing.id;
    }
    const buildKind: BuildKind = candidateKind(kind);
    const number =
      history.count(
        (row) => row.kind === buildKind && row.version.startsWith(`${formatVersion(core)}-`),
      ) + 1;
    return insertBuild(tx, {
      applicationId: application.id,
      applicationName: application.name,
      kind: buildKind,
      version: candidateVersion(core, buildKind, number),
      branch,
      pullRequest: null,
      commit,
      trigger: request.trigger,
      requestedBy: request.requestedBy,
    });
  }

  /** Saves the release build of a merge into main, once. Returns whether it saved one. */
  async #recordRelease(application: ApplicationView, pullRequest: PullRequest): Promise<boolean> {
    const line = parseLineBranch(pullRequest.head.branch);
    if (
      line === null ||
      !pullRequest.merged ||
      pullRequest.base.branch !== PRODUCTION_BRANCH ||
      pullRequest.mergeCommit === null ||
      !isCommit(pullRequest.mergeCommit)
    ) {
      return false;
    }
    const trigger = `merged:pr-${pullRequest.number}`;
    return this.#database.transaction(async (tx) => {
      await lockApplication(tx, application.id);
      const history = await VersionHistory.load(tx, application.id);
      // Each version is built once. A second merge of the same branch is ignored.
      if (history.byTrigger(trigger) !== undefined || history.hasRelease(line.version)) {
        return false;
      }
      await insertBuild(tx, {
        applicationId: application.id,
        applicationName: application.name,
        kind: 'release',
        version: line.version,
        branch: line.branch,
        pullRequest: pullRequest.number,
        commit: pullRequest.mergeCommit!,
        trigger,
        requestedBy: null,
      });
      return true;
    });
  }

  async #activeApplication(applicationId: unknown): Promise<ApplicationView> {
    const application = await this.#catalog.get(applicationId);
    if (application.status === 'archived') {
      throw new BuildError('conflict', 'Restore the application first.');
    }
    return application;
  }
}

function parsePullRequestNumber(value: unknown): number {
  const number = typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
    throw new BuildError('invalid', 'The pull request number is not valid.');
  }
  return number;
}

function createdTrigger(branch: string, commit: string): string {
  return `created:${branch}@${commit}`;
}

function isCommit(value: string): boolean {
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value);
}
