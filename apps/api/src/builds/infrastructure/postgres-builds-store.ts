import type { SbomDocument } from '@dreamdevops/contracts/builds/http';
import { currentCompanyId } from '@dreamdevops/shared-kernel';
import { PostgresSession, type TenantDatabase, transactional } from '@dreamdevops/shared-kernel/postgres';
import type { BuildsSession, BuildsStore, NewBuild, StoredBuild, StoredSigningKey } from '../application/ports.ts';
import type { BuildKind, BuildStatus, Reports, SigningPurpose } from '../domain/build.ts';
import type { PlatformChecks } from '../domain/image-rules.ts';

interface BuildRow {
  id: string;
  application_id: string;
  kind: BuildKind;
  branch: string | null;
  commit_sha: string;
  image_tag: string;
  version: string | null;
  release_id: string | null;
  status: BuildStatus;
  failure_reason: string | null;
  reports: Reports;
  image_ref: string | null;
  digest: string | null;
  signing_key: SigningPurpose | null;
  token_hash: string | null;
  token_expires_at: Date | null;
  created_at: Date;
  finished_at: Date | null;
}

/** Each company's builds, SBOMs and signing keys, in the builds schema. */
export function postgresBuildsStore(database: TenantDatabase): BuildsStore {
  return transactional(database, (tx) => new PostgresBuildsSession(tx));
}

class PostgresBuildsSession extends PostgresSession implements BuildsSession {
  async lockApplication(applicationId: string): Promise<void> {
    await this.tx.query("SELECT pg_advisory_xact_lock(hashtextextended('builds:' || $1, 0))", [applicationId]);
  }

  async reusableBuild(applicationId: string, tag: string): Promise<string | null> {
    const { rows } = await this.tx.query<{ id: string }>(
      `SELECT id FROM builds.builds
       WHERE application_id = $1 AND image_tag = $2 AND status IN ('queued', 'running', 'succeeded')`,
      [applicationId, tag],
    );
    return rows[0]?.id ?? null;
  }

  async add(build: NewBuild): Promise<void> {
    await this.tx.query(
      `INSERT INTO builds.builds
         (id, company_id, application_id, kind, branch, commit_sha, image_tag, version, release_id,
          status, signing_key, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $11)`,
      [
        build.id,
        currentCompanyId(),
        build.applicationId,
        build.kind,
        build.branch,
        build.commit,
        build.tag,
        build.version,
        build.releaseId,
        build.signingKey,
        build.requestedBy,
      ],
    );
  }

  async find(id: string, options: { readonly lock?: boolean } = {}): Promise<StoredBuild | null> {
    const { rows } = await this.tx.query<BuildRow>(`SELECT * FROM builds.builds WHERE id = $1${options.lock ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] === undefined ? null : toBuild(rows[0]);
  }

  async list(applicationId: string, limit: number): Promise<StoredBuild[]> {
    const { rows } = await this.tx.query<BuildRow>(
      'SELECT * FROM builds.builds WHERE application_id = $1 ORDER BY created_at DESC LIMIT $2',
      [applicationId, limit],
    );
    return rows.map(toBuild);
  }

  async versions(applicationId: string, limit: number): Promise<StoredBuild[]> {
    const { rows } = await this.tx.query<BuildRow>(
      `SELECT * FROM builds.builds WHERE application_id = $1 AND status = 'succeeded' AND kind <> 'check'
       ORDER BY created_at DESC LIMIT $2`,
      [applicationId, limit],
    );
    return rows.map(toBuild);
  }

  async many(ids: readonly string[]): Promise<StoredBuild[]> {
    const { rows } = await this.tx.query<BuildRow>('SELECT * FROM builds.builds WHERE id = ANY($1)', [ids]);
    return rows.map(toBuild);
  }

  async featureImages(applicationId: string, branch: string): Promise<StoredBuild[]> {
    const { rows } = await this.tx.query<BuildRow>(
      "SELECT * FROM builds.builds WHERE application_id = $1 AND kind = 'feature' AND branch = $2 AND status = 'succeeded'",
      [applicationId, branch],
    );
    return rows.map(toBuild);
  }

  async addReports(id: string, reports: Readonly<Partial<Record<keyof Reports, unknown>>>): Promise<void> {
    await this.tx.query('UPDATE builds.builds SET reports = reports || $2::jsonb, updated_at = now() WHERE id = $1', [
      id,
      JSON.stringify(reports),
    ]);
  }

  async markJobStarted(id: string, job: string): Promise<void> {
    await this.tx.query(
      `UPDATE builds.builds
       SET reports = jsonb_set(reports, '{started}', coalesce(reports->'started', '{}'::jsonb) || jsonb_build_object($2::text, now()))
       WHERE id = $1 AND NOT coalesce(reports->'started' ? $2, false)`,
      [id, job],
    );
  }

  async startRunning(id: string, tokenHash: string, timeoutMinutes: number): Promise<boolean> {
    const { rowCount } = await this.tx.query(
      `UPDATE builds.builds
       SET status = 'running', token_hash = $2, token_expires_at = now() + make_interval(mins => $3),
           pipeline_started_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'queued'`,
      [id, tokenHash, timeoutMinutes],
    );
    return rowCount === 1;
  }

  async storeImage(id: string, image: { readonly digest: string; readonly ref: string; readonly size: number }): Promise<void> {
    await this.tx.query(
      `UPDATE builds.builds
       SET digest = $2, image_ref = $3, reports = reports || $4::jsonb, updated_at = now()
       WHERE id = $1`,
      [id, image.digest, image.ref, JSON.stringify({ image: { digest: image.digest, size: image.size } })],
    );
  }

  async markSigned(id: string, verification: PlatformChecks): Promise<void> {
    await this.tx.query('UPDATE builds.builds SET signed_at = now(), reports = reports || $2::jsonb, updated_at = now() WHERE id = $1', [
      id,
      JSON.stringify({ verification }),
    ]);
  }

  async finish(id: string, status: 'succeeded' | 'failed', reason: string | null): Promise<StoredBuild> {
    const { rows } = await this.tx.query<BuildRow>(
      `UPDATE builds.builds
       SET status = $2, failure_reason = $3, token_hash = NULL, token_expires_at = NULL,
           finished_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, status, reason],
    );
    return toBuild(rows[0]!);
  }

  async markDeleted(id: string): Promise<void> {
    await this.tx.query("UPDATE builds.builds SET status = 'deleted', updated_at = now() WHERE id = $1", [id]);
  }

  async sbom(buildId: string): Promise<SbomDocument | null> {
    const { rows } = await this.tx.query<{ document: SbomDocument }>('SELECT document FROM builds.sboms WHERE build_id = $1', [buildId]);
    return rows[0]?.document ?? null;
  }

  async addSbom(buildId: string, document: unknown): Promise<void> {
    await this.tx.query('INSERT INTO builds.sboms (build_id, company_id, document) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
      buildId,
      currentCompanyId(),
      JSON.stringify(document),
    ]);
  }

  async companyOfBuild(buildId: string): Promise<string | null> {
    const { rows } = await this.tx.query<{ build_company: string | null }>('SELECT builds.build_company($1)', [buildId]);
    return rows[0]?.build_company ?? null;
  }

  async stale(timeoutMinutes: number): Promise<{ readonly buildId: string; readonly companyId: string }[]> {
    const { rows } = await this.tx.query<{ build_id: string; company_id: string }>(
      'SELECT * FROM builds.stale_builds(now() - make_interval(mins => $1))',
      [timeoutMinutes],
    );
    return rows.map((row) => ({ buildId: row.build_id, companyId: row.company_id }));
  }

  async unstarted(startTimeoutMinutes: number): Promise<{ readonly buildId: string; readonly companyId: string }[]> {
    const { rows } = await this.tx.query<{ build_id: string; company_id: string }>(
      'SELECT * FROM builds.unstarted_builds(now() - make_interval(mins => $1))',
      [startTimeoutMinutes],
    );
    return rows.map((row) => ({ buildId: row.build_id, companyId: row.company_id }));
  }

  async signingKey(purpose: SigningPurpose): Promise<StoredSigningKey | null> {
    const { rows } = await this.tx.query<{ public_key: string; private_key: string }>(
      'SELECT public_key, private_key FROM builds.signing_keys WHERE purpose = $1',
      [purpose],
    );
    return rows[0] === undefined ? null : { purpose, publicKey: rows[0].public_key, encryptedPrivateKey: rows[0].private_key };
  }

  async addSigningKey(key: StoredSigningKey): Promise<boolean> {
    const { rowCount } = await this.tx.query(
      `INSERT INTO builds.signing_keys (company_id, purpose, public_key, private_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, purpose) DO NOTHING`,
      [currentCompanyId(), key.purpose, key.publicKey, key.encryptedPrivateKey],
    );
    return rowCount === 1;
  }

  async publicKeys(): Promise<{ readonly purpose: SigningPurpose; readonly publicKey: string }[]> {
    const { rows } = await this.tx.query<{ purpose: SigningPurpose; public_key: string }>(
      'SELECT purpose, public_key FROM builds.signing_keys ORDER BY purpose',
    );
    return rows.map((row) => ({ purpose: row.purpose, publicKey: row.public_key }));
  }
}

function toBuild(row: BuildRow): StoredBuild {
  return {
    id: row.id,
    applicationId: row.application_id,
    kind: row.kind,
    branch: row.branch,
    commit: row.commit_sha,
    tag: row.image_tag,
    version: row.version,
    releaseId: row.release_id,
    status: row.status,
    failureReason: row.failure_reason,
    reports: row.reports,
    imageRef: row.image_ref,
    digest: row.digest,
    signingKey: row.signing_key,
    tokenHash: row.token_hash,
    tokenExpiresAt: row.token_expires_at,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}
