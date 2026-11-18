import { randomUUID } from 'node:crypto';
import type { DeploymentAction, ResourceLimits } from '@dreamdevops/contracts/deployments/http';
import { currentCompanyId } from '@dreamdevops/shared-kernel';
import { PostgresSession, type TenantDatabase, transactional } from '@dreamdevops/shared-kernel/postgres';
import type {
  CommandAction,
  DeploymentFilter,
  DeploymentsSession,
  DeploymentsStore,
  NewDeployment,
  StoredDeployment,
} from '../application/ports.ts';
import type { DeploymentStatus, Progress } from '../domain/deployment.ts';
import type { Strategy } from '../domain/manifests.ts';

interface DeploymentRow {
  id: string;
  environment_id: string;
  application_id: string;
  build_id: string;
  strategy: Strategy;
  status: DeploymentStatus;
  rollback_of: string | null;
  commit_sha: string | null;
  progress: Progress;
  message: string | null;
  requested_by: string | null;
  requester_name: string | null;
  approved_by: string | null;
  approver_name: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
  reason: string | null;
  action: DeploymentAction;
  limits: ResourceLimits | null;
  config_hash: string | null;
}

/** Deployments with the names of who asked and who approved, which the app's role reads through a function. */
const SELECT = 'SELECT d.* FROM deployments.deployments_view() d';

/** Each company's deployments and the commands for its agents, in the deployments schema. */
export function postgresDeploymentsStore(database: TenantDatabase): DeploymentsStore {
  return transactional(database, (tx) => new PostgresDeploymentsSession(tx));
}

class PostgresDeploymentsSession extends PostgresSession implements DeploymentsSession {
  async list(filter: DeploymentFilter, limit: number): Promise<StoredDeployment[]> {
    const { where, values } = filtered(filter, []);
    const { rows } = await this.tx.query<DeploymentRow>(`${SELECT} ${where} ORDER BY d.created_at DESC LIMIT ${Number(limit)}`, values);
    return rows.map(toDeployment);
  }

  async running(filter: DeploymentFilter): Promise<StoredDeployment[]> {
    const { where, values } = filtered(filter, ["d.status = 'succeeded'", "d.action <> 'stop'"]);
    const { rows } = await this.tx.query<DeploymentRow>(`${SELECT} ${where} ORDER BY d.finished_at DESC`, values);
    return rows.map(toDeployment);
  }

  async find(id: string, options: { readonly lock?: boolean } = {}): Promise<StoredDeployment | null> {
    if (options.lock) {
      await this.tx.query('SELECT 1 FROM deployments.deployments WHERE id = $1 FOR UPDATE', [id]);
    }
    const { rows } = await this.tx.query<DeploymentRow>(`${SELECT} WHERE d.id = $1`, [id]);
    return rows[0] === undefined ? null : toDeployment(rows[0]);
  }

  async inEnvironment(environmentId: string, statuses: readonly DeploymentStatus[]): Promise<StoredDeployment[]> {
    const { rows } = await this.tx.query<DeploymentRow>(`${SELECT} WHERE d.environment_id = $1 AND d.status = ANY($2) ORDER BY d.id`, [
      environmentId,
      statuses,
    ]);
    return rows.map(toDeployment);
  }

  async previousSuccess(deployment: StoredDeployment, options: { readonly otherVersion: boolean }): Promise<StoredDeployment | null> {
    const { rows } = await this.tx.query<DeploymentRow>(
      `${SELECT} WHERE d.environment_id = $1 AND d.application_id = $2 AND d.status IN ('succeeded', 'superseded')
         AND d.action <> 'stop' AND d.created_at < $3 AND ($5 = false OR d.build_id <> $4)
       ORDER BY d.created_at DESC LIMIT 1`,
      [deployment.environmentId, deployment.applicationId, deployment.createdAt, deployment.buildId, options.otherVersion],
    );
    return rows[0] === undefined ? null : toDeployment(rows[0]);
  }

  async applicationsOf(deploymentIds: readonly string[]): Promise<string[]> {
    const { rows } = await this.tx.query<{ application_id: string }>(
      'SELECT DISTINCT application_id FROM deployments.deployments WHERE id = ANY($1)',
      [deploymentIds],
    );
    return rows.map((row) => row.application_id);
  }

  async lastPort(environmentId: string, applicationId: string): Promise<number | null> {
    const { rows } = await this.tx.query<{ port: number | null }>(
      `SELECT (progress->>'port')::int AS port FROM deployments.deployments
       WHERE environment_id = $1 AND application_id = $2 AND status IN ('succeeded', 'superseded') AND progress ? 'port'
       ORDER BY finished_at DESC LIMIT 1`,
      [environmentId, applicationId],
    );
    return rows[0]?.port ?? null;
  }

  async add(deployment: NewDeployment): Promise<boolean> {
    // A savepoint, so a deployment already going leaves the transaction usable.
    await this.tx.query('SAVEPOINT add_deployment');
    try {
      await this.tx.query(
        `INSERT INTO deployments.deployments
           (id, company_id, environment_id, application_id, build_id, strategy, status, rollback_of, requested_by, reason, action)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          deployment.id,
          currentCompanyId(),
          deployment.environmentId,
          deployment.applicationId,
          deployment.buildId,
          deployment.strategy,
          deployment.status,
          deployment.rollbackOf,
          deployment.requestedBy,
          deployment.reason,
          deployment.action,
        ],
      );
      await this.tx.query('RELEASE SAVEPOINT add_deployment');
      return true;
    } catch (error) {
      // Only one deployment of an application may be going in an environment at a time.
      if ((error as { code?: string }).code === '23505') {
        await this.tx.query('ROLLBACK TO SAVEPOINT add_deployment');
        return false;
      }
      throw error;
    }
  }

  async decide(id: string, approved: boolean, decidedBy: string): Promise<void> {
    await this.tx.query(
      `UPDATE deployments.deployments
       SET status = $2, approved_by = $3, approved_at = now(), updated_at = now(),
           finished_at = CASE WHEN $2 = 'rejected' THEN now() END
       WHERE id = $1`,
      [id, approved ? 'queued' : 'rejected', decidedBy],
    );
  }

  async markCommitted(
    id: string,
    committed: { readonly commitSha: string; readonly limits: ResourceLimits | null; readonly configHash: string | null },
  ): Promise<boolean> {
    const { rowCount } = await this.tx.query(
      `UPDATE deployments.deployments
       SET status = 'committed', commit_sha = $2, limits = $3, config_hash = $4, message = NULL, updated_at = now()
       WHERE id = $1 AND status = 'queued'`,
      [id, committed.commitSha, committed.limits === null ? null : JSON.stringify(committed.limits), committed.configHash],
    );
    return rowCount !== 0;
  }

  async updateRollout(
    id: string,
    rollout: { readonly status: DeploymentStatus; readonly progress: Progress; readonly message: string | null; readonly finished: boolean },
  ): Promise<void> {
    await this.tx.query(
      `UPDATE deployments.deployments
       SET status = $2, progress = $3, message = $4, updated_at = now(),
           finished_at = CASE WHEN $5 THEN now() END
       WHERE id = $1`,
      [id, rollout.status, JSON.stringify(rollout.progress), rollout.message, rollout.finished],
    );
  }

  async markProgressing(id: string, progress: Progress, message: string): Promise<void> {
    await this.tx.query(
      `UPDATE deployments.deployments SET status = 'progressing', progress = $2, message = $3, updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'progressing')`,
      [id, JSON.stringify(progress), message],
    );
  }

  async finishRun(
    id: string,
    run: {
      readonly status: 'succeeded' | 'failed';
      readonly message: string;
      readonly progress: Progress;
      readonly limits: ResourceLimits | null;
      readonly configHash: string | null;
    },
  ): Promise<boolean> {
    const { rowCount } = await this.tx.query(
      `UPDATE deployments.deployments
       SET status = $2, message = $3, progress = $4, limits = coalesce($5, limits), config_hash = coalesce($6, config_hash),
           finished_at = now(), updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'progressing')`,
      [id, run.status, run.message, JSON.stringify(run.progress), run.limits === null ? null : JSON.stringify(run.limits), run.configHash],
    );
    return rowCount !== 0;
  }

  async fail(id: string, message: string): Promise<void> {
    await this.tx.query(
      "UPDATE deployments.deployments SET status = 'failed', message = $2, updated_at = now(), finished_at = now() WHERE id = $1",
      [id, message],
    );
  }

  async supersedeOthers(deployment: StoredDeployment): Promise<void> {
    await this.tx.query(
      `UPDATE deployments.deployments SET status = 'superseded', updated_at = now()
       WHERE environment_id = $1 AND application_id = $2 AND status = 'succeeded' AND id <> $3`,
      [deployment.environmentId, deployment.applicationId, deployment.id],
    );
  }

  async stalled(cutoff: Date): Promise<{ readonly deploymentId: string; readonly companyId: string }[]> {
    const { rows } = await this.tx.query<{ deployment_id: string; company_id: string }>('SELECT * FROM deployments.stalled_deployments($1)', [
      cutoff,
    ]);
    return rows.map((row) => ({ deploymentId: row.deployment_id, companyId: row.company_id }));
  }

  async hasOpenCommand(deploymentId: string, action: CommandAction): Promise<boolean> {
    const { rows } = await this.tx.query(
      "SELECT 1 FROM deployments.commands WHERE deployment_id = $1 AND action = $2 AND status IN ('pending', 'sent')",
      [deploymentId, action],
    );
    return rows.length > 0;
  }

  async addCommand(deploymentId: string, environmentId: string, action: CommandAction): Promise<void> {
    await this.tx.query(
      `INSERT INTO deployments.commands (id, company_id, deployment_id, environment_id, action, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [randomUUID(), currentCompanyId(), deploymentId, environmentId, action],
    );
  }

  async addPromoteOnce(deploymentId: string, environmentId: string): Promise<void> {
    await this.tx.query(
      `INSERT INTO deployments.commands (id, company_id, deployment_id, environment_id, action, status)
       SELECT $1, $2, $3, $4, 'promote', 'pending'
       WHERE NOT EXISTS (SELECT 1 FROM deployments.commands WHERE deployment_id = $3 AND action = 'promote')`,
      [randomUUID(), currentCompanyId(), deploymentId, environmentId],
    );
  }

  async applicationsWithPendingCommands(environmentId: string): Promise<string[]> {
    const { rows } = await this.tx.query<{ application_id: string }>(
      `SELECT DISTINCT d.application_id FROM deployments.commands c
       JOIN deployments.deployments d ON d.id = c.deployment_id
       WHERE c.environment_id = $1 AND c.status = 'pending'`,
      [environmentId],
    );
    return rows.map((row) => row.application_id);
  }

  async sendPendingCommands(
    environmentId: string,
    applicationIds: readonly string[],
  ): Promise<{ readonly id: string; readonly action: CommandAction; readonly applicationId: string }[]> {
    const { rows } = await this.tx.query<{ id: string; action: CommandAction; application_id: string }>(
      `UPDATE deployments.commands c SET status = 'sent', updated_at = now()
       FROM deployments.deployments d
       WHERE c.deployment_id = d.id AND c.environment_id = $1 AND c.status = 'pending' AND d.application_id = ANY($2)
       RETURNING c.id, c.action, d.application_id`,
      [environmentId, applicationIds],
    );
    return rows.map((row) => ({ id: row.id, action: row.action, applicationId: row.application_id }));
  }

  async completeCommand(id: string, environmentId: string, result: { readonly succeeded: boolean; readonly message: string | null }): Promise<void> {
    await this.tx.query(
      `UPDATE deployments.commands SET status = $3, message = $4, updated_at = now()
       WHERE id = $1 AND environment_id = $2 AND status = 'sent'`,
      [id, environmentId, result.succeeded ? 'done' : 'failed', result.message],
    );
  }
}

/** The WHERE clause for a filter, after the conditions given. */
function filtered(filter: DeploymentFilter, conditions: string[]): { where: string; values: string[] } {
  const values: string[] = [];
  const all = [...conditions];
  if (filter.applicationId !== undefined) {
    values.push(filter.applicationId);
    all.push(`d.application_id = $${values.length}`);
  }
  if (filter.environmentId !== undefined) {
    values.push(filter.environmentId);
    all.push(`d.environment_id = $${values.length}`);
  }
  return { where: all.length === 0 ? '' : `WHERE ${all.join(' AND ')}`, values };
}

function toDeployment(row: DeploymentRow): StoredDeployment {
  return {
    id: row.id,
    environmentId: row.environment_id,
    applicationId: row.application_id,
    buildId: row.build_id,
    strategy: row.strategy,
    status: row.status,
    rollbackOf: row.rollback_of,
    commitSha: row.commit_sha,
    progress: row.progress,
    message: row.message,
    requestedBy: row.requested_by,
    requesterName: row.requester_name,
    approvedBy: row.approved_by,
    approverName: row.approver_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    reason: row.reason,
    action: row.action,
    limits: row.limits,
    configHash: row.config_hash,
  };
}
