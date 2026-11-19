import type { ReleaseStatus } from '@dreamdevops/contracts/releases/http';
import { currentCompanyId } from '@dreamdevops/shared-kernel';
import { PostgresSession, type TenantDatabase, transactional } from '@dreamdevops/shared-kernel/postgres';
import type { ReleasesSession, ReleasesStore, StoredCandidate, StoredRelease } from '../application/ports.ts';
import type { ReleaseKind } from '../domain/version.ts';

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

/** Each company's releases and their candidates, in the releases schema. */
export function postgresReleasesStore(database: TenantDatabase): ReleasesStore {
  return transactional(database, (tx) => new PostgresReleasesSession(tx), { role: 'dreamdevops_releases' });
}

class PostgresReleasesSession extends PostgresSession implements ReleasesSession {
  async list(applicationId: string): Promise<StoredRelease[]> {
    const { rows } = await this.tx.query<ReleaseRow>('SELECT * FROM releases.releases WHERE application_id = $1 ORDER BY created_at DESC', [
      applicationId,
    ]);
    return rows.map(toRelease);
  }

  async candidatesOf(applicationId: string): Promise<StoredCandidate[]> {
    const { rows } = await this.tx.query<{ release_id: string; number: number; commit_sha: string; tag: string; build_id: string | null }>(
      `SELECT c.* FROM releases.candidates c
       JOIN releases.releases r ON r.id = c.release_id
       WHERE r.application_id = $1
       ORDER BY c.number DESC`,
      [applicationId],
    );
    return rows.map((row) => ({ releaseId: row.release_id, number: row.number, commit: row.commit_sha, tag: row.tag, buildId: row.build_id }));
  }

  async lockApplication(applicationId: string): Promise<void> {
    await this.tx.query("SELECT pg_advisory_xact_lock(hashtextextended('releases:' || $1, 0))", [applicationId]);
  }

  async add(release: {
    readonly id: string;
    readonly applicationId: string;
    readonly kind: ReleaseKind;
    readonly version: string;
    readonly branch: string;
    readonly startedBy: string;
  }): Promise<void> {
    await this.tx.query(
      `INSERT INTO releases.releases (id, company_id, application_id, kind, version, branch, status, started_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)`,
      [release.id, currentCompanyId(), release.applicationId, release.kind, release.version, release.branch, release.startedBy],
    );
  }

  async find(id: string, options: { readonly lock?: boolean } = {}): Promise<StoredRelease | null> {
    const { rows } = await this.tx.query<ReleaseRow>(`SELECT * FROM releases.releases WHERE id = $1${options.lock ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] === undefined ? null : toRelease(rows[0]);
  }

  async openOnBranch(applicationId: string, branch: string): Promise<StoredRelease | null> {
    const { rows } = await this.tx.query<ReleaseRow>(
      "SELECT * FROM releases.releases WHERE application_id = $1 AND branch = $2 AND status = 'open'",
      [applicationId, branch],
    );
    return rows[0] === undefined ? null : toRelease(rows[0]);
  }

  async lockUnpublishedOnBranch(applicationId: string, branch: string): Promise<StoredRelease | null> {
    const { rows } = await this.tx.query<ReleaseRow>(
      "SELECT * FROM releases.releases WHERE application_id = $1 AND branch = $2 AND status IN ('open', 'merged') FOR UPDATE",
      [applicationId, branch],
    );
    return rows[0] === undefined ? null : toRelease(rows[0]);
  }

  async open(applicationId?: string): Promise<StoredRelease[]> {
    const { rows } = await this.tx.query<ReleaseRow>(
      "SELECT * FROM releases.releases WHERE status = 'open' AND ($1::uuid IS NULL OR application_id = $1)",
      [applicationId ?? null],
    );
    return rows.map(toRelease);
  }

  async companiesWithOpenReleases(): Promise<string[]> {
    const { rows } = await this.tx.query<{ company_id: string }>('SELECT * FROM releases.companies_with_open_releases()');
    return rows.map((row) => row.company_id);
  }

  async markMerged(id: string, mergeCommit: string): Promise<void> {
    await this.tx.query(
      `UPDATE releases.releases SET status = 'merged', merge_commit = $2, merged_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, mergeCommit],
    );
  }

  async markPublished(id: string): Promise<boolean> {
    const { rowCount } = await this.tx.query(
      `UPDATE releases.releases SET status = 'published', published_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'merged'`,
      [id],
    );
    return rowCount === 1;
  }

  async setMergeBackPullRequest(id: string, number: number | null): Promise<void> {
    await this.tx.query('UPDATE releases.releases SET merge_back_pull_request = $2, updated_at = now() WHERE id = $1', [id, number]);
  }

  async setFinalBuild(id: string, buildId: string): Promise<void> {
    await this.tx.query('UPDATE releases.releases SET final_build_id = $2, updated_at = now() WHERE id = $1', [id, buildId]);
  }

  async hasCandidate(releaseId: string, commit: string): Promise<boolean> {
    const { rows } = await this.tx.query('SELECT 1 FROM releases.candidates WHERE release_id = $1 AND commit_sha = $2', [releaseId, commit]);
    return rows.length > 0;
  }

  async addCandidate(candidate: { readonly releaseId: string; readonly number: number; readonly commit: string; readonly tag: string }): Promise<void> {
    await this.tx.query('INSERT INTO releases.candidates (release_id, company_id, number, commit_sha, tag) VALUES ($1, $2, $3, $4, $5)', [
      candidate.releaseId,
      currentCompanyId(),
      candidate.number,
      candidate.commit,
      candidate.tag,
    ]);
    await this.tx.query('UPDATE releases.releases SET candidates = $2, last_candidate_commit = $3, updated_at = now() WHERE id = $1', [
      candidate.releaseId,
      candidate.number,
      candidate.commit,
    ]);
  }

  async setCandidateBuild(releaseId: string, number: number, buildId: string): Promise<void> {
    await this.tx.query('UPDATE releases.candidates SET build_id = $3 WHERE release_id = $1 AND number = $2', [releaseId, number, buildId]);
  }
}

function toRelease(row: ReleaseRow): StoredRelease {
  return {
    id: row.id,
    applicationId: row.application_id,
    kind: row.kind,
    version: row.version,
    branch: row.branch,
    status: row.status,
    candidates: row.candidates,
    lastCandidateCommit: row.last_candidate_commit,
    mergeCommit: row.merge_commit,
    mergeBackPullRequest: row.merge_back_pull_request,
    finalBuildId: row.final_build_id,
    createdAt: row.created_at,
    mergedAt: row.merged_at,
    publishedAt: row.published_at,
  };
}
