import { randomUUID } from 'node:crypto';
import { createDomainEvent, currentCompanyId, isUuid } from '@dreamdevops/shared-kernel';
import { appendToOutbox, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import { type Check, type Fact, initialSteps, STEP_NAMES, type StepKey, type StepRecord, type StepStatus } from '../domain/pipeline.ts';
import { type BuildKind, compareVersions, coreVersion, formatVersion, newest, parseVersion, type Version } from '../domain/versions.ts';
import { BuildError } from '../domain/errors.ts';
import type { RepositoryLookup } from '../../source-governance/application/repository-lookup.ts';
import type { RepositoryRef } from './ports.ts';

export type BuildStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface BuildRow {
  id: string;
  application_id: string;
  number: number;
  kind: BuildKind;
  version: string;
  branch: string;
  pull_request: number | null;
  commit_sha: string;
  trigger: string;
  status: BuildStatus;
  steps: StepRecord[];
  image: string | null;
  digest: string | null;
  attempts: number;
  last_error: string | null;
  requested_by: string | null;
  requester_name: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface StepView {
  readonly key: StepKey;
  readonly name: string;
  readonly status: StepStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly summary: string | null;
  readonly checks: readonly Check[];
  readonly facts: readonly Fact[];
}

export interface BuildView {
  readonly id: string;
  readonly applicationId: string;
  readonly number: number;
  readonly kind: BuildKind;
  readonly version: string;
  readonly status: BuildStatus;
  readonly branch: string;
  readonly pullRequest: number | null;
  readonly commit: string;
  readonly image: string | null;
  readonly digest: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly requestedBy: { readonly userId: string; readonly displayName: string | null } | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly steps: readonly StepView[];
}

/** Reads through a function, because the app's database role can't read user names directly. */
export const SELECT_BUILDS = 'SELECT * FROM builds.builds_view() b';

export function toView(row: BuildRow): BuildView {
  return {
    id: row.id,
    applicationId: row.application_id,
    number: row.number,
    kind: row.kind,
    version: row.version,
    status: row.status,
    branch: row.branch,
    pullRequest: row.pull_request,
    commit: row.commit_sha,
    image: row.image,
    digest: row.digest,
    attempts: row.attempts,
    lastError: row.last_error,
    requestedBy: row.requested_by === null ? null : { userId: row.requested_by, displayName: row.requester_name },
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    steps: row.steps.map((step) => ({ ...step, name: STEP_NAMES[step.key] })),
  };
}

export function parseBuildId(value: unknown): string {
  if (!isUuid(value)) {
    throw new BuildError('invalid', 'The build ID is not valid.');
  }
  return value;
}

export async function findBuild(tx: TenantTransaction, id: string): Promise<BuildRow | null> {
  const { rows } = await tx.query<BuildRow>(`${SELECT_BUILDS} WHERE b.id = $1`, [id]);
  return rows[0] ?? null;
}

/** One change to an application's builds at a time, so two requests can't take the same version. */
export async function lockApplication(tx: TenantTransaction, applicationId: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('builds:' || $1, 0))", [applicationId]);
}

/** The application's repository, which must be ready before anything can be built from it. */
export async function readyRepository(repositories: RepositoryLookup, applicationId: string): Promise<RepositoryRef> {
  const repository = await repositories.find(applicationId);
  if (repository?.status !== 'ready') {
    throw new BuildError('conflict', "This application's repository isn't ready yet.");
  }
  return { organization: repository.organization, name: repository.name };
}

interface HistoryRow {
  id: string;
  kind: BuildKind;
  version: string;
  status: BuildStatus;
  branch: string;
  pull_request: number | null;
  commit_sha: string;
  trigger: string;
  number: number;
}

export interface OpenLine {
  readonly kind: 'release' | 'hotfix';
  readonly branch: string;
  readonly version: Version;
  /** Its candidates, newest first. */
  readonly candidates: readonly HistoryRow[];
}

/** What an application's builds say about its versions. */
export class VersionHistory {
  readonly rows: readonly HistoryRow[];

  constructor(rows: readonly HistoryRow[]) {
    this.rows = rows;
  }

  static async load(tx: TenantTransaction, applicationId: string): Promise<VersionHistory> {
    const { rows } = await tx.query<HistoryRow>(
      `SELECT id, kind, version, status, branch, pull_request, commit_sha, trigger, number
       FROM builds.builds WHERE application_id = $1 ORDER BY number DESC`,
      [applicationId],
    );
    return new VersionHistory(rows);
  }

  /**
   * The newest version merged into main, whether or not its image was published. New
   * releases and hotfixes count up from it, so versions on main only ever go up.
   */
  onMain(options: { except?: string } = {}): Version | null {
    return newest(
      this.rows
        .filter((row) => row.kind === 'release' && row.id !== options.except)
        .map((row) => parseVersion(row.version)!),
    );
  }

  /** The newest release whose image was published, signed and tagged. */
  published(): Version | null {
    return newest(
      this.rows.filter((row) => row.kind === 'release' && row.status === 'succeeded').map((row) => parseVersion(row.version)!),
    );
  }

  hasRelease(version: Version): boolean {
    return this.rows.some((row) => row.kind === 'release' && row.version === formatVersion(version));
  }

  /**
   * Release and hotfix lines whose candidates were built, but which haven't been merged
   * into main yet. A line older than what's on main can't be merged, so it isn't open.
   */
  openLines(): OpenLine[] {
    const onMain = this.onMain();
    const lines = new Map<string, OpenLine>();
    for (const row of this.rows) {
      if (row.kind !== 'release-candidate' && row.kind !== 'hotfix-candidate') {
        continue;
      }
      const core = parseVersion(coreVersion(parseVersion(row.version)!))!;
      if (this.hasRelease(core) || (onMain !== null && compareVersions(core, onMain) <= 0)) {
        continue;
      }
      const key = `${row.kind}:${formatVersion(core)}`;
      const line = lines.get(key);
      if (line === undefined) {
        lines.set(key, {
          kind: row.kind === 'release-candidate' ? 'release' : 'hotfix',
          branch: row.branch,
          version: core,
          candidates: [row],
        });
      } else {
        lines.set(key, { ...line, candidates: [...line.candidates, row] });
      }
    }
    return [...lines.values()];
  }

  /** How many builds of one kind exist for a release line, or for a pull request. */
  count(filter: (row: HistoryRow) => boolean): number {
    return this.rows.filter(filter).length;
  }

  byTrigger(trigger: string): HistoryRow | undefined {
    return this.rows.find((row) => row.trigger === trigger);
  }
}

export interface NewBuild {
  readonly applicationId: string;
  readonly applicationName: string;
  readonly kind: BuildKind;
  readonly version: Version;
  readonly branch: string;
  readonly pullRequest: number | null;
  readonly commit: string;
  readonly trigger: string;
  readonly requestedBy: string | null;
}

/** Saves a queued build and the event that starts it, together. Call it under lockApplication. */
export async function insertBuild(tx: TenantTransaction, build: NewBuild): Promise<string> {
  const id = randomUUID();
  const version = formatVersion(build.version);
  const { rows } = await tx.query<{ next: number }>(
    'SELECT coalesce(max(number), 0) + 1 AS next FROM builds.builds WHERE application_id = $1',
    [build.applicationId],
  );
  await tx.query(
    `INSERT INTO builds.builds
       (id, company_id, application_id, number, kind, version, branch, pull_request, commit_sha, trigger, status, steps, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued', $11, $12)`,
    [
      id,
      currentCompanyId(),
      build.applicationId,
      rows[0]!.next,
      build.kind,
      version,
      build.branch,
      build.pullRequest,
      build.commit,
      build.trigger,
      JSON.stringify(initialSteps(build.kind)),
      build.requestedBy,
    ],
  );
  await appendToOutbox(tx, [
    queuedEvent(build.requestedBy, {
      buildId: id,
      applicationId: build.applicationId,
      name: build.applicationName,
      kind: build.kind,
      version,
      branch: build.branch,
      pullRequest: build.pullRequest,
    }),
  ]);
  return id;
}

export function queuedEvent(actorId: string | null, payload: Readonly<Record<string, unknown>> & { buildId: string }) {
  return createDomainEvent({ eventType: 'BuildQueued', companyId: currentCompanyId(), actorId, payload });
}
