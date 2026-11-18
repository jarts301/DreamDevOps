import { createHash, randomUUID } from 'node:crypto';
import type { EnvironmentStatus, TargetStatus } from '@dreamdevops/contracts/environments/http';
import { currentCompanyId } from '@dreamdevops/shared-kernel';
import { PostgresSession, type TenantDatabase, transactional } from '@dreamdevops/shared-kernel/postgres';
import type {
  EnvironmentsSession,
  EnvironmentsStore,
  StoredEnvironment,
  StoredTarget,
  StoredValue,
  ValueKind,
  ValueScope,
} from '../application/ports.ts';
import type { EnvironmentKind } from '../domain/environment.ts';
import type { HostingProviderKey, HostingSettings } from '../domain/hosting-providers.ts';

interface EnvironmentRow {
  id: string;
  name: string;
  slug: string;
  kind: EnvironmentKind;
  accepts_feature_images: boolean;
  requires_approval: boolean;
  status: EnvironmentStatus;
  created_at: Date;
  archived_at: Date | null;
  repository: string | null;
}

interface TargetRow {
  id: string;
  environment_id: string;
  provider: HostingProviderKey;
  settings: HostingSettings;
  status: TargetStatus;
  registration_token_hash: string | null;
  registration_expires_at: Date | null;
  public_key: string | null;
  access_token_hash: string | null;
  access_token_expires_at: Date | null;
  agent_version: string | null;
  kubernetes_version: string | null;
  registered_at: Date | null;
  last_seen_at: Date | null;
  created_at: Date;
}

const ENVIRONMENT_COLUMNS = `id, name, slug, kind, accepts_feature_images, requires_approval, status, created_at, archived_at, repository`;
const TARGET_COLUMNS = `id, environment_id, provider, settings, status, registration_token_hash, registration_expires_at, public_key,
  access_token_hash, access_token_expires_at, agent_version, kubernetes_version, registered_at, last_seen_at, created_at`;
/** Values in exactly one scope: the environment's own, or one application's. */
const IN_SCOPE = 'environment_id = $1 AND application_id IS NOT DISTINCT FROM $2';
/** What an application gets: the environment's values, and its own. */
const FOR_APPLICATION = 'environment_id = $1 AND (application_id IS NULL OR application_id = $2)';

/** Each company's environments, targets, values and pull account, in the environments schema. */
export function postgresEnvironmentsStore(database: TenantDatabase): EnvironmentsStore {
  return transactional(database, (tx) => new PostgresEnvironmentsSession(tx));
}

class PostgresEnvironmentsSession extends PostgresSession implements EnvironmentsSession {
  // ---- Environments

  async listEnvironments(status: EnvironmentStatus): Promise<StoredEnvironment[]> {
    const { rows } = await this.tx.query<EnvironmentRow>(
      `SELECT ${ENVIRONMENT_COLUMNS} FROM environments.environments WHERE status = $1
       ORDER BY kind = 'production' DESC, lower(name)`,
      [status],
    );
    return rows.map(toEnvironment);
  }

  async findEnvironment(id: string, options: { readonly lock?: boolean } = {}): Promise<StoredEnvironment | null> {
    const { rows } = await this.tx.query<EnvironmentRow>(
      `SELECT ${ENVIRONMENT_COLUMNS} FROM environments.environments WHERE id = $1${options.lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] === undefined ? null : toEnvironment(rows[0]);
  }

  async lockNames(): Promise<void> {
    await this.tx.query("SELECT pg_advisory_xact_lock(hashtextextended('environments:' || $1, 0))", [currentCompanyId()]);
  }

  async statusOfName(name: string, exceptId: string | null): Promise<EnvironmentStatus | null> {
    const { rows } = await this.tx.query<{ status: EnvironmentStatus }>(
      'SELECT status FROM environments.environments WHERE lower(name) = lower($1) AND id <> $2',
      [name, exceptId ?? '00000000-0000-0000-0000-000000000000'],
    );
    return rows[0]?.status ?? null;
  }

  async isSlugTaken(slug: string): Promise<boolean> {
    const { rows } = await this.tx.query('SELECT 1 FROM environments.environments WHERE slug = $1', [slug]);
    return rows.length > 0;
  }

  async addEnvironment(environment: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly kind: EnvironmentKind;
    readonly acceptsFeatureImages: boolean;
    readonly createdBy: string;
  }): Promise<void> {
    await this.tx.query(
      `INSERT INTO environments.environments
         (id, company_id, name, slug, kind, accepts_feature_images, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
      [
        environment.id,
        currentCompanyId(),
        environment.name,
        environment.slug,
        environment.kind,
        environment.acceptsFeatureImages,
        environment.createdBy,
      ],
    );
  }

  async updateEnvironment(
    id: string,
    changes: { readonly name: string; readonly acceptsFeatureImages: boolean; readonly requiresApproval: boolean },
  ): Promise<void> {
    await this.tx.query(
      `UPDATE environments.environments
       SET name = $2, accepts_feature_images = $3, requires_approval = $4, updated_at = now()
       WHERE id = $1`,
      [id, changes.name, changes.acceptsFeatureImages, changes.requiresApproval],
    );
  }

  async setEnvironmentStatus(id: string, status: EnvironmentStatus): Promise<void> {
    await this.tx.query(
      `UPDATE environments.environments
       SET status = $2, archived_at = CASE WHEN $2 = 'archived' THEN now() END, updated_at = now()
       WHERE id = $1`,
      [id, status],
    );
  }

  async setRepository(id: string, name: string): Promise<void> {
    await this.tx.query('UPDATE environments.environments SET repository = $2 WHERE id = $1', [id, name]);
  }

  // ---- Targets

  async currentTargets(): Promise<StoredTarget[]> {
    const { rows } = await this.tx.query<TargetRow>(`SELECT ${TARGET_COLUMNS} FROM environments.targets WHERE status <> 'revoked'`);
    return rows.map(toTarget);
  }

  async currentTarget(environmentId: string): Promise<StoredTarget | null> {
    const { rows } = await this.tx.query<TargetRow>(
      `SELECT ${TARGET_COLUMNS} FROM environments.targets WHERE environment_id = $1 AND status <> 'revoked'`,
      [environmentId],
    );
    return rows[0] === undefined ? null : toTarget(rows[0]);
  }

  async findTarget(id: string, options: { readonly lock?: boolean } = {}): Promise<StoredTarget | null> {
    const { rows } = await this.tx.query<TargetRow>(
      `SELECT ${TARGET_COLUMNS} FROM environments.targets WHERE id = $1${options.lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] === undefined ? null : toTarget(rows[0]);
  }

  async revokeTarget(id: string, revokedBy: string): Promise<void> {
    await this.tx.query(
      `UPDATE environments.targets
       SET status = 'revoked', registration_token_hash = NULL, access_token_hash = NULL,
           access_token_expires_at = NULL, revoked_at = now(), revoked_by = $2, updated_at = now()
       WHERE id = $1`,
      [id, revokedBy],
    );
  }

  async addPendingTarget(target: {
    readonly id: string;
    readonly environmentId: string;
    readonly registrationTokenHash: string;
    readonly registrationMinutes: number;
    readonly createdBy: string;
  }): Promise<Date> {
    const { rows } = await this.tx.query<{ registration_expires_at: Date }>(
      `INSERT INTO environments.targets
         (id, company_id, environment_id, status, registration_token_hash, registration_expires_at, created_by)
       VALUES ($1, $2, $3, 'pending', $4, now() + make_interval(mins => $5), $6)
       RETURNING registration_expires_at`,
      [target.id, currentCompanyId(), target.environmentId, target.registrationTokenHash, target.registrationMinutes, target.createdBy],
    );
    return rows[0]!.registration_expires_at;
  }

  async addConnectedTarget(target: {
    readonly id: string;
    readonly environmentId: string;
    readonly provider: HostingProviderKey;
    readonly settings: HostingSettings;
    readonly createdBy: string;
  }): Promise<void> {
    await this.tx.query(
      `INSERT INTO environments.targets (id, company_id, environment_id, provider, settings, status, registered_at, created_by)
       VALUES ($1, $2, $3, $4, $5, 'connected', now(), $6)`,
      [target.id, currentCompanyId(), target.environmentId, target.provider, JSON.stringify(target.settings), target.createdBy],
    );
  }

  async completeRegistration(
    id: string,
    agent: { readonly publicKey: string; readonly agentVersion: string | null; readonly kubernetesVersion: string | null },
  ): Promise<void> {
    await this.tx.query(
      `UPDATE environments.targets
       SET status = 'connected', registration_token_hash = NULL, registration_expires_at = NULL,
           public_key = $2, agent_version = $3, kubernetes_version = $4,
           registered_at = now(), last_seen_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, agent.publicKey, agent.agentVersion, agent.kubernetesVersion],
    );
  }

  async useAssertion(targetId: string, assertion: { readonly assertionId: string; readonly expiresAt: Date }): Promise<boolean> {
    await this.tx.query('DELETE FROM environments.used_assertions WHERE target_id = $1 AND expires_at < now()', [targetId]);
    const { rowCount } = await this.tx.query(
      `INSERT INTO environments.used_assertions (target_id, company_id, assertion_id, expires_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [targetId, currentCompanyId(), assertion.assertionId, assertion.expiresAt],
    );
    return rowCount !== 0;
  }

  async setAccessToken(id: string, hash: string, minutes: number): Promise<void> {
    await this.tx.query(
      `UPDATE environments.targets
       SET access_token_hash = $2, access_token_expires_at = now() + make_interval(mins => $3), updated_at = now()
       WHERE id = $1`,
      [id, hash, minutes],
    );
  }

  async markSeen(id: string): Promise<void> {
    await this.tx.query(`UPDATE environments.targets SET status = 'connected', last_seen_at = now(), updated_at = now() WHERE id = $1`, [id]);
  }

  async updateVersions(id: string, versions: { readonly agentVersion: string | null; readonly kubernetesVersion: string | null }): Promise<void> {
    await this.tx.query(
      `UPDATE environments.targets
       SET agent_version = coalesce($2, agent_version), kubernetes_version = coalesce($3, kubernetes_version)
       WHERE id = $1`,
      [id, versions.agentVersion, versions.kubernetesVersion],
    );
  }

  async markLostIfSilent(id: string, cutoff: Date): Promise<{ readonly environmentId: string; readonly lastSeenAt: Date } | null> {
    const { rows } = await this.tx.query<{ environment_id: string; last_seen_at: Date }>(
      `UPDATE environments.targets SET status = 'lost', updated_at = now()
       WHERE id = $1 AND status = 'connected' AND last_seen_at < $2
       RETURNING environment_id, last_seen_at`,
      [id, cutoff],
    );
    return rows[0] === undefined ? null : { environmentId: rows[0].environment_id, lastSeenAt: rows[0].last_seen_at };
  }

  async setDeployKey(targetId: string, publicKey: string): Promise<void> {
    await this.tx.query('UPDATE environments.targets SET deploy_key = $2, updated_at = now() WHERE id = $1', [targetId, publicKey]);
  }

  async silentTargets(cutoff: Date): Promise<{ readonly targetId: string; readonly companyId: string }[]> {
    const { rows } = await this.tx.query<{ target_id: string; company_id: string }>('SELECT * FROM environments.silent_targets($1)', [cutoff]);
    return rows.map((row) => ({ targetId: row.target_id, companyId: row.company_id }));
  }

  async companyOfTarget(targetId: string): Promise<string | null> {
    const { rows } = await this.tx.query<{ target_company: string | null }>('SELECT environments.target_company($1)', [targetId]);
    return rows[0]?.target_company ?? null;
  }

  // ---- Variables and secrets

  async values(kind: ValueKind, scope: ValueScope): Promise<StoredValue[]> {
    const { rows } = await this.tx.query<{
      name: string;
      value?: string;
      application_id: string | null;
      updated_at: Date;
      updated_by: string | null;
    }>(
      `SELECT name, ${kind === 'variables' ? 'value, ' : ''}application_id, updated_at, updated_by FROM environments.${kind}
       WHERE ${FOR_APPLICATION}
       ORDER BY name, application_id NULLS FIRST`,
      [scope.environmentId, scope.applicationId],
    );
    return rows.map((row) => ({
      name: row.name,
      value: row.value ?? null,
      applicationId: row.application_id,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    }));
  }

  async nameInScope(kind: ValueKind, scope: ValueScope, name: string): Promise<string | null> {
    const { rows } = await this.tx.query<{ name: string }>(
      `SELECT name FROM environments.${kind} WHERE ${IN_SCOPE} AND upper(name) = upper($3)`,
      [scope.environmentId, scope.applicationId, name],
    );
    return rows[0]?.name ?? null;
  }

  async setVariable(scope: ValueScope, variable: { readonly name: string; readonly value: string; readonly updatedBy: string }): Promise<void> {
    await this.tx.query(
      `INSERT INTO environments.variables (id, company_id, environment_id, application_id, name, value, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (environment_id, coalesce(application_id, '00000000-0000-0000-0000-000000000000'), upper(name))
       DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [randomUUID(), currentCompanyId(), scope.environmentId, scope.applicationId, variable.name, variable.value, variable.updatedBy],
    );
  }

  async setSecret(scope: ValueScope, secret: { readonly name: string; readonly bytes: number; readonly updatedBy: string }): Promise<void> {
    await this.tx.query(
      `INSERT INTO environments.secrets (id, company_id, environment_id, application_id, name, value_bytes, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (environment_id, coalesce(application_id, '00000000-0000-0000-0000-000000000000'), upper(name))
       DO UPDATE SET value_bytes = excluded.value_bytes, updated_by = excluded.updated_by, updated_at = now()`,
      [randomUUID(), currentCompanyId(), scope.environmentId, scope.applicationId, secret.name, secret.bytes, secret.updatedBy],
    );
  }

  async removeValue(kind: ValueKind, scope: ValueScope, name: string): Promise<boolean> {
    const { rowCount } = await this.tx.query(`DELETE FROM environments.${kind} WHERE ${IN_SCOPE} AND name = $3`, [
      scope.environmentId,
      scope.applicationId,
      name,
    ]);
    return rowCount !== 0;
  }

  async sizes(scope: ValueScope): Promise<number[]> {
    const { rows } = await this.tx.query<{ bytes: number }>(
      `SELECT octet_length(value) AS bytes FROM environments.variables WHERE ${IN_SCOPE}
       UNION ALL
       SELECT value_bytes FROM environments.secrets WHERE ${IN_SCOPE}`,
      [scope.environmentId, scope.applicationId],
    );
    return rows.map((row) => Number(row.bytes));
  }

  async variablesFor(environmentId: string, applicationId: string): Promise<{ readonly name: string; readonly value: string }[]> {
    const { rows } = await this.tx.query<{ name: string; value: string }>(
      `SELECT name, value FROM environments.variables WHERE ${FOR_APPLICATION} ORDER BY application_id NULLS FIRST`,
      [environmentId, applicationId],
    );
    return rows;
  }

  async secretScopes(environmentId: string, applicationId: string): Promise<{ readonly shared: boolean; readonly application: boolean }> {
    const { rows } = await this.tx.query<{ application_id: string | null }>(
      `SELECT DISTINCT application_id FROM environments.secrets WHERE ${FOR_APPLICATION}`,
      [environmentId, applicationId],
    );
    return { shared: rows.some((row) => row.application_id === null), application: rows.some((row) => row.application_id !== null) };
  }

  async fingerprint(environmentId: string, applicationId: string): Promise<string> {
    const order = 'ORDER BY application_id NULLS FIRST, name';
    const { rows: variables } = await this.tx.query(
      `SELECT name, value, application_id FROM environments.variables WHERE ${FOR_APPLICATION} ${order}`,
      [environmentId, applicationId],
    );
    // Secret values aren't here, but every change to one is: it's saved again.
    const { rows: secrets } = await this.tx.query(
      `SELECT name, application_id, value_bytes, updated_at FROM environments.secrets WHERE ${FOR_APPLICATION} ${order}`,
      [environmentId, applicationId],
    );
    return createHash('sha256').update(JSON.stringify([variables, secrets])).digest('hex');
  }

  // ---- The company's pull account

  async lockPullAccount(): Promise<void> {
    await this.tx.query("SELECT pg_advisory_xact_lock(hashtextextended('pull-account:' || $1, 0))", [currentCompanyId()]);
  }

  async pullAccount(): Promise<{ readonly username: string; readonly sealedToken: string } | null> {
    const { rows } = await this.tx.query<{ username: string; token: string }>('SELECT username, token FROM environments.pull_accounts');
    return rows[0] === undefined ? null : { username: rows[0].username, sealedToken: rows[0].token };
  }

  async addPullAccount(username: string, sealedToken: string): Promise<void> {
    await this.tx.query('INSERT INTO environments.pull_accounts (company_id, username, token) VALUES ($1, $2, $3)', [
      currentCompanyId(),
      username,
      sealedToken,
    ]);
  }
}

function toEnvironment(row: EnvironmentRow): StoredEnvironment {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    acceptsFeatureImages: row.accepts_feature_images,
    requiresApproval: row.requires_approval,
    status: row.status,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    repository: row.repository,
  };
}

function toTarget(row: TargetRow): StoredTarget {
  return {
    id: row.id,
    environmentId: row.environment_id,
    provider: row.provider,
    settings: row.settings,
    status: row.status,
    registrationTokenHash: row.registration_token_hash,
    registrationExpiresAt: row.registration_expires_at,
    publicKey: row.public_key,
    accessTokenHash: row.access_token_hash,
    accessTokenExpiresAt: row.access_token_expires_at,
    agentVersion: row.agent_version,
    kubernetesVersion: row.kubernetes_version,
    registeredAt: row.registered_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}
