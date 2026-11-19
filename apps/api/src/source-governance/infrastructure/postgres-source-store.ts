import type { RepositoryStatus } from '@dreamdevops/contracts/source-governance/http';
import { currentCompanyId } from '@dreamdevops/shared-kernel';
import { PostgresSession, type TenantDatabase, transactional } from '@dreamdevops/shared-kernel/postgres';
import type { MemberAccount, SourceSession, SourceStore, StoredRepository } from '../application/ports.ts';

interface RepositoryRow {
  application_id: string;
  organization: string;
  name: string;
  status: RepositoryStatus;
  blueprint_key: string | null;
  blueprint_version: string | null;
  attempts: number;
  last_error: string | null;
}

/** Each company's repositories, in the source schema. */
export function postgresSourceStore(database: TenantDatabase): SourceStore {
  return transactional(database, (tx) => new PostgresSourceSession(tx), { role: 'dreamdevops_source' });
}

class PostgresSourceSession extends PostgresSession implements SourceSession {
  async list(): Promise<StoredRepository[]> {
    const { rows } = await this.tx.query<RepositoryRow>('SELECT * FROM source.repositories ORDER BY name');
    return rows.map(toRepository);
  }

  async find(applicationId: string): Promise<StoredRepository | null> {
    const { rows } = await this.tx.query<RepositoryRow>('SELECT * FROM source.repositories WHERE application_id = $1', [applicationId]);
    return rows[0] === undefined ? null : toRepository(rows[0]);
  }

  async findByName(organization: string, name: string): Promise<StoredRepository | null> {
    const { rows } = await this.tx.query<RepositoryRow>('SELECT * FROM source.repositories WHERE organization = $1 AND name = $2', [
      organization,
      name,
    ]);
    return rows[0] === undefined ? null : toRepository(rows[0]);
  }

  async lock(applicationId: string): Promise<StoredRepository | null> {
    const { rows } = await this.tx.query<RepositoryRow>('SELECT * FROM source.repositories WHERE application_id = $1 FOR UPDATE', [
      applicationId,
    ]);
    return rows[0] === undefined ? null : toRepository(rows[0]);
  }

  async markCreating(applicationId: string, organization: string, name: string): Promise<void> {
    await this.tx.query(
      `INSERT INTO source.repositories (application_id, company_id, organization, name, status)
       VALUES ($1, $2, $3, $4, 'creating')
       ON CONFLICT (application_id) DO UPDATE SET status = 'creating', attempts = 0, last_error = NULL, updated_at = now()`,
      [applicationId, currentCompanyId(), organization, name],
    );
  }

  async claim(applicationId: string, seconds: number): Promise<boolean> {
    const { rowCount } = await this.tx.query(
      `UPDATE source.repositories SET claimed_until = now() + make_interval(secs => $2)
       WHERE application_id = $1 AND (claimed_until IS NULL OR claimed_until < now())`,
      [applicationId, seconds],
    );
    return rowCount === 1;
  }

  async renewClaim(applicationId: string, seconds: number): Promise<void> {
    await this.tx.query('UPDATE source.repositories SET claimed_until = now() + make_interval(secs => $2) WHERE application_id = $1', [
      applicationId,
      seconds,
    ]);
  }

  async chooseBlueprint(applicationId: string, blueprint: { readonly key: string; readonly version: string }): Promise<void> {
    await this.tx.query('UPDATE source.repositories SET blueprint_key = $2, blueprint_version = $3 WHERE application_id = $1', [
      applicationId,
      blueprint.key,
      blueprint.version,
    ]);
  }

  async markReady(applicationId: string, externalId: string, policyVersion: number): Promise<void> {
    await this.tx.query(
      `UPDATE source.repositories
       SET status = 'ready', external_id = $2, attempts = 0, last_error = NULL,
           policy_version = $3, claimed_until = NULL, updated_at = now()
       WHERE application_id = $1`,
      [applicationId, externalId, policyVersion],
    );
  }

  async recordFailure(
    applicationId: string,
    failure: { readonly failed: boolean; readonly attempts: number; readonly error: string },
  ): Promise<void> {
    await this.tx.query(
      `UPDATE source.repositories SET status = $2, attempts = $3, last_error = $4, claimed_until = NULL, updated_at = now()
       WHERE application_id = $1`,
      [applicationId, failure.failed ? 'failed' : 'creating', failure.attempts, failure.error],
    );
  }

  async outdated(policyVersion: number): Promise<StoredRepository[]> {
    const { rows } = await this.tx.query<RepositoryRow>("SELECT * FROM source.repositories WHERE status = 'ready' AND policy_version < $1", [
      policyVersion,
    ]);
    return rows.map(toRepository);
  }

  async setPolicyVersion(applicationId: string, policyVersion: number): Promise<void> {
    await this.tx.query('UPDATE source.repositories SET policy_version = $2, updated_at = now() WHERE application_id = $1', [
      applicationId,
      policyVersion,
    ]);
  }

  async companiesWithOutdatedRepositories(policyVersion: number): Promise<string[]> {
    const { rows } = await this.tx.query<{ company_id: string }>('SELECT * FROM source.companies_with_outdated_repositories($1)', [
      policyVersion,
    ]);
    return rows.map((row) => row.company_id);
  }

  async memberAccounts(userId?: string): Promise<MemberAccount[]> {
    const { rows } = await this.tx.query<{ user_id: string; username: string; permissions: string[] }>(
      'SELECT * FROM source.member_accounts() WHERE $1::uuid IS NULL OR user_id = $1',
      [userId ?? null],
    );
    return rows.map((row) => ({ userId: row.user_id, username: row.username, permissions: row.permissions }));
  }
}

function toRepository(row: RepositoryRow): StoredRepository {
  return {
    applicationId: row.application_id,
    organization: row.organization,
    name: row.name,
    status: row.status,
    blueprint: row.blueprint_key !== null && row.blueprint_version !== null ? { key: row.blueprint_key, version: row.blueprint_version } : null,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}
