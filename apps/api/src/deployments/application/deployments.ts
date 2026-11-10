import { randomUUID } from 'node:crypto';
import { type CompanyId, createDomainEvent, currentCompanyId, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { BlueprintLibrary } from '../../blueprints/infrastructure/blueprint-library.ts';
import type { Entitlements } from '../../editions/application/entitlements.ts';
import type { EnvironmentConfig } from '../../environments/application/environment-config.ts';
import type { EnvironmentRepositories, FileChange } from '../../environments/application/ports.ts';
import type { TargetConfigurations } from '../../environments/application/target-configuration.ts';
import type { Principal } from '../../identity-access/domain/access.ts';
import {
  ACTIVE_STATUSES,
  advance,
  assertAccepts,
  type DeploymentStatus,
  isProgressive,
  parseStrategy,
  type Progress,
  ROLLING_OUT,
  type SyncReport,
  type WorkloadReport,
} from '../domain/deployment.ts';
import { DeploymentError } from '../domain/errors.ts';
import {
  applicationFolder,
  DEFAULT_RUNTIME,
  renderApplication,
  renderRoot,
  type Runtime,
  type Strategy,
} from '../domain/manifests.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_COMPANY = parseCompanyId('00000000-0000-0000-0000-000000000000');
/** A rollout that hasn't moved for this long has failed. */
export const STALL_MINUTES = 15;

export interface DeploymentView {
  readonly id: string;
  readonly application: { readonly id: string; readonly name: string; readonly slug: string };
  readonly environment: { readonly id: string; readonly name: string; readonly kind: 'test' | 'production' };
  readonly version: { readonly buildId: string; readonly kind: string; readonly tag: string; readonly version: string | null };
  readonly strategy: Strategy;
  readonly status: DeploymentStatus;
  readonly message: string | null;
  readonly progress: Progress;
  readonly rollbackOf: string | null;
  readonly commit: string | null;
  readonly requestedBy: { readonly userId: string; readonly displayName: string | null } | null;
  readonly approvedBy: { readonly userId: string; readonly displayName: string | null } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export interface AgentCommand {
  readonly id: string;
  readonly action: 'promote' | 'abort';
  readonly namespace: string;
  readonly name: string;
}

export interface DeploymentsOptions {
  /** How targets reach the registry, so images are named as targets pull them. */
  readonly targetRegistryHost: string;
}

interface Row {
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
  application_name: string;
  application_slug: string;
  environment_name: string;
  environment_kind: 'test' | 'production';
  build_kind: string;
  image_tag: string;
  build_version: string | null;
}

interface EnvironmentRow {
  id: string;
  name: string;
  slug: string;
  kind: 'test' | 'production';
  accepts_feature_images: boolean;
  requires_approval: boolean;
  status: string;
}

const SELECT = `
  SELECT d.*, a.name AS application_name, a.slug AS application_slug, e.name AS environment_name,
         e.kind AS environment_kind, b.kind AS build_kind, b.image_tag, b.version AS build_version
  FROM deployments.deployments_view() d
  JOIN catalog.applications a ON a.id = d.application_id
  JOIN environments.environments e ON e.id = d.environment_id
  JOIN builds.builds b ON b.id = d.build_id`;

/**
 * Runs versions of applications in environments. A deployment is a commit to the
 * environment's repository; the target's Flux applies it, and its agent reports how the
 * rollout goes. Promote and abort reach the agent as commands with its next heartbeat.
 */
export class Deployments {
  readonly #database: TenantDatabase;
  readonly #configurations: TargetConfigurations;
  readonly #repositories: EnvironmentRepositories;
  readonly #config: EnvironmentConfig;
  readonly #blueprints: BlueprintLibrary;
  readonly #entitlements: Entitlements;
  readonly #options: DeploymentsOptions;

  constructor(
    database: TenantDatabase,
    configurations: TargetConfigurations,
    repositories: EnvironmentRepositories,
    config: EnvironmentConfig,
    blueprints: BlueprintLibrary,
    entitlements: Entitlements,
    options: DeploymentsOptions,
  ) {
    this.#database = database;
    this.#configurations = configurations;
    this.#repositories = repositories;
    this.#config = config;
    this.#blueprints = blueprints;
    this.#entitlements = entitlements;
    this.#options = options;
  }

  async list(filter: { application?: unknown; environment?: unknown }): Promise<DeploymentView[]> {
    const conditions: string[] = [];
    const values: string[] = [];
    if (filter.application !== undefined && filter.application !== '') {
      values.push(parseId(filter.application, 'application'));
      conditions.push(`d.application_id = $${values.length}`);
    }
    if (filter.environment !== undefined && filter.environment !== '') {
      values.push(parseId(filter.environment, 'environment'));
      conditions.push(`d.environment_id = $${values.length}`);
    }
    return this.#database.transaction(async (tx) => {
      const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
      const { rows } = await tx.query<Row>(`${SELECT} ${where} ORDER BY d.created_at DESC LIMIT 50`, values);
      return rows.map(toView);
    });
  }

  async get(idValue: unknown): Promise<DeploymentView> {
    const id = parseId(idValue, 'deployment');
    return this.#database.transaction(async (tx) => toView(await findOrFail(tx, id)));
  }

  /** Asks to run a version in an environment. Production may need a second person's approval first. */
  async request(
    actor: Principal,
    applicationValue: unknown,
    input: { environment?: unknown; version?: unknown; strategy?: unknown },
  ): Promise<DeploymentView> {
    const applicationId = parseId(applicationValue, 'application');
    const environmentId = parseId(input.environment, 'environment');
    const buildId = parseId(input.version, 'version');
    const strategy = parseStrategy(input.strategy);
    if (isProgressive(strategy)) {
      // Canary and A/B need a traffic router and automatic analysis, which aren't built yet.
      throw (await this.#entitlements.isEnabled(currentCompanyId(), 'progressive-deployments'))
        ? new DeploymentError('invalid', 'Canary and A/B deployments are not available yet.')
        : new DeploymentError('not-entitled', 'Canary and A/B deployments need the Commercial Edition.');
    }
    return this.#create(actor, { applicationId, environmentId, buildId, strategy, rollbackOf: null });
  }

  async #create(
    actor: Principal,
    input: { applicationId: string; environmentId: string; buildId: string; strategy: Strategy; rollbackOf: string | null },
  ): Promise<DeploymentView> {
    const id = randomUUID();
    return this.#database.transaction(async (tx) => {
      const environment = await findEnvironment(tx, input.environmentId);
      assertMayDeploy(actor, environment.kind);
      if (environment.status !== 'active') {
        throw new DeploymentError('conflict', 'Restore the environment first.');
      }
      const { rows: applications } = await tx.query<{ status: string }>('SELECT status FROM catalog.applications WHERE id = $1', [
        input.applicationId,
      ]);
      if (applications[0] === undefined) {
        throw new DeploymentError('not-found', 'This application does not exist.');
      }
      if (applications[0].status !== 'active') {
        throw new DeploymentError('conflict', 'Restore the application first.');
      }
      const { rows: builds } = await tx.query<{ kind: string; status: string; application_id: string }>(
        'SELECT kind, status, application_id FROM builds.builds WHERE id = $1',
        [input.buildId],
      );
      if (builds[0] === undefined || builds[0].application_id !== input.applicationId) {
        throw new DeploymentError('not-found', 'This version does not exist.');
      }
      assertAccepts(environment, builds[0]);
      const { rows: targets } = await tx.query<{ status: string }>(
        "SELECT status FROM environments.targets WHERE environment_id = $1 AND status <> 'revoked'",
        [input.environmentId],
      );
      if (targets[0]?.status !== 'connected') {
        throw new DeploymentError(
          'conflict',
          targets[0]?.status === 'lost'
            ? `The target of ${environment.name} isn't reporting, so nothing can be deployed there now.`
            : `${environment.name} has no connected target yet.`,
        );
      }
      // Rollbacks restore a version that already ran, so they don't wait for approval.
      const needsApproval = environment.requires_approval && input.rollbackOf === null;
      const status: DeploymentStatus = needsApproval ? 'awaiting-approval' : 'queued';
      try {
        await tx.query(
          `INSERT INTO deployments.deployments
             (id, company_id, environment_id, application_id, build_id, strategy, status, rollback_of, requested_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, currentCompanyId(), input.environmentId, input.applicationId, input.buildId, input.strategy, status, input.rollbackOf, actor.userId],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new DeploymentError('conflict', `A deployment of this application to ${environment.name} is still going.`);
        }
        throw error;
      }
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'DeploymentRequested',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: {
            deploymentId: id,
            applicationId: input.applicationId,
            environmentId: input.environmentId,
            environmentName: environment.name,
            buildId: input.buildId,
            strategy: input.strategy,
            rollbackOf: input.rollbackOf,
            needsApproval,
          },
        }),
        ...(needsApproval ? [] : [queued(id, actor.userId)]),
      ]);
      return toView(await findOrFail(tx, id));
    });
  }

  /** A second person with production rights approves; the one who asked can't. */
  approve(actor: Principal, idValue: unknown): Promise<void> {
    return this.#decide(actor, idValue, true);
  }

  reject(actor: Principal, idValue: unknown): Promise<void> {
    return this.#decide(actor, idValue, false);
  }

  #decide(actor: Principal, idValue: unknown, approved: boolean): Promise<void> {
    const id = parseId(idValue, 'deployment');
    return this.#database.transaction(async (tx) => {
      const deployment = await findOrFail(tx, id, { lock: true });
      if (!actor.permissions.includes('deployments-production:run')) {
        throw new DeploymentError('forbidden', 'Only Tech Leads and Operators approve production deployments.');
      }
      if (deployment.status !== 'awaiting-approval') {
        throw new DeploymentError('conflict', 'This deployment is not waiting for approval.');
      }
      if (deployment.requested_by === actor.userId) {
        throw new DeploymentError('forbidden', 'Someone else must approve your deployment.');
      }
      await tx.query(
        `UPDATE deployments.deployments
         SET status = $2, approved_by = $3, approved_at = now(), updated_at = now(),
             finished_at = CASE WHEN $2 = 'rejected' THEN now() END
         WHERE id = $1`,
        [id, approved ? 'queued' : 'rejected', actor.userId],
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: approved ? 'DeploymentApproved' : 'DeploymentRejected',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { deploymentId: id, applicationId: deployment.application_id, environmentName: deployment.environment_name },
        }),
        ...(approved ? [queued(id, actor.userId)] : []),
      ]);
    });
  }

  /** Writes the version to the environment's repository. Runs in the background. */
  async commit(idValue: string): Promise<void> {
    const deployment = await this.#database.transaction((tx) => findOrFail(tx, idValue));
    if (deployment.status !== 'queued') {
      return;
    }
    const repository = await this.#configurations.repositoryOf(deployment.environment_id);
    const files = await this.#database.transaction((tx) => this.#render(tx, deployment));
    const sha = await this.#write(repository, deployment, files, `Deploy ${deployment.application_slug} ${deployment.build_version ?? deployment.image_tag} with ${deployment.strategy}`);
    await this.#database.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE deployments.deployments
         SET status = 'committed', commit_sha = $2, message = NULL, updated_at = now()
         WHERE id = $1 AND status = 'queued'`,
        [deployment.id, sha],
      );
      if (rowCount === 0) {
        return;
      }
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: 'DeploymentStarted',
          companyId: currentCompanyId(),
          actorId: null,
          payload: { deploymentId: deployment.id, applicationId: deployment.application_id, environmentName: deployment.environment_name, commit: sha },
        }),
      ]);
    });
  }

  /** After a failed or aborted rollout, Git goes back to the last version that ran well, so Flux keeps it. */
  async restorePrevious(idValue: string): Promise<void> {
    const deployment = await this.#database.transaction((tx) => findOrFail(tx, idValue));
    const previous = await this.#database.transaction((tx) => previousSuccess(tx, deployment));
    const repository = await this.#configurations.repositoryOf(deployment.environment_id);
    if (previous === null) {
      // Nothing ran here before: the application's folder goes, and with it what was applied.
      await this.#write(repository, deployment, new Map(), `Remove ${deployment.application_slug}: its first deployment did not succeed`);
      return;
    }
    const files = await this.#database.transaction((tx) => this.#render(tx, previous));
    await this.#write(repository, previous, files, `Restore ${previous.application_slug} ${previous.build_version ?? previous.image_tag}`);
  }

  /** Switches traffic to a blue/green deployment's new version. */
  promote(actor: Principal, idValue: unknown): Promise<void> {
    return this.#command(actor, idValue, 'promote', (deployment) => {
      if (deployment.status !== 'paused') {
        throw new DeploymentError('conflict', 'Only a blue/green deployment waiting on its preview can be promoted.');
      }
    });
  }

  /** Stops a rolling or blue/green rollout and returns traffic to the previous version. */
  abort(actor: Principal, idValue: unknown): Promise<void> {
    return this.#command(actor, idValue, 'abort', (deployment) => {
      if (deployment.strategy === 'recreate') {
        throw new DeploymentError('conflict', "A recreate deployment can't be aborted. Roll it back instead.");
      }
      if (deployment.status !== 'progressing' && deployment.status !== 'paused') {
        throw new DeploymentError('conflict', 'Only a rollout in progress can be aborted.');
      }
    });
  }

  /** Runs the last version that ran well before this one, with the same strategy. */
  async rollback(actor: Principal, idValue: unknown): Promise<DeploymentView> {
    const id = parseId(idValue, 'deployment');
    const { deployment, previous } = await this.#database.transaction(async (tx) => {
      const deployment = await findOrFail(tx, id);
      return { deployment, previous: await previousSuccess(tx, deployment) };
    });
    if (!['succeeded', 'superseded', 'failed', 'aborted'].includes(deployment.status)) {
      throw new DeploymentError('conflict', 'Only a finished deployment can be rolled back.');
    }
    if (previous === null) {
      throw new DeploymentError('conflict', 'There is no earlier version that ran well here.');
    }
    return this.#create(actor, {
      applicationId: deployment.application_id,
      environmentId: deployment.environment_id,
      buildId: previous.build_id,
      strategy: deployment.strategy,
      rollbackOf: deployment.id,
    });
  }

  async #command(
    actor: Principal,
    idValue: unknown,
    action: 'promote' | 'abort',
    check: (deployment: Row) => void,
  ): Promise<void> {
    const id = parseId(idValue, 'deployment');
    await this.#database.transaction(async (tx) => {
      const deployment = await findOrFail(tx, id, { lock: true });
      assertMayDeploy(actor, deployment.environment_kind);
      check(deployment);
      const { rows } = await tx.query("SELECT 1 FROM deployments.commands WHERE deployment_id = $1 AND action = $2 AND status IN ('pending', 'sent')", [id, action]);
      if (rows.length > 0) {
        return;
      }
      await tx.query(
        `INSERT INTO deployments.commands (id, company_id, deployment_id, environment_id, action, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [randomUUID(), currentCompanyId(), id, deployment.environment_id, action],
      );
      await appendToOutbox(tx, [
        createDomainEvent({
          eventType: action === 'promote' ? 'DeploymentPromoted' : 'DeploymentAbortRequested',
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { deploymentId: id, applicationId: deployment.application_id, environmentName: deployment.environment_name },
        }),
      ]);
    });
  }

  /**
   * Takes an agent's report: moves its environment's rollouts along, and hands back the
   * commands waiting for it. Called with each heartbeat.
   */
  onReport(
    companyId: CompanyId,
    environmentId: string,
    report: { sync?: unknown; workloads?: unknown },
  ): Promise<AgentCommand[]> {
    const sync = parseSync(report.sync);
    const workloads = parseWorkloads(report.workloads);
    return runWithCompany(companyId, () =>
      this.#database.transaction(async (tx) => {
        const { rows } = await tx.query<Row>(
          `${SELECT} WHERE d.environment_id = $1 AND d.status = ANY($2)`,
          [environmentId, ROLLING_OUT],
        );
        for (const deployment of rows) {
          const next = advance(
            { status: deployment.status, commitSha: deployment.commit_sha },
            workloads.find((workload) => workload.deploymentId === deployment.id),
            sync,
          );
          const progressChanged = JSON.stringify(next.progress) !== JSON.stringify(deployment.progress);
          if (next.status === deployment.status && !progressChanged && next.message === deployment.message) {
            continue;
          }
          const finished = ['succeeded', 'failed', 'aborted'].includes(next.status);
          await tx.query(
            `UPDATE deployments.deployments
             SET status = $2, progress = $3, message = $4, updated_at = now(),
                 finished_at = CASE WHEN $5 THEN now() END
             WHERE id = $1`,
            [deployment.id, next.status, JSON.stringify(next.progress), next.message, finished],
          );
          if (finished) {
            await appendToOutbox(tx, [finishedEvent(deployment, next.status, next.message)]);
          }
          // Only the newest version that ran well is running; the earlier ones are replaced.
          if (next.status === 'succeeded') {
            await tx.query(
              `UPDATE deployments.deployments SET status = 'superseded', updated_at = now()
               WHERE environment_id = $1 AND application_id = $2 AND status = 'succeeded' AND id <> $3`,
              [deployment.environment_id, deployment.application_id, deployment.id],
            );
          }
          // A rollback goes back to a version that ran well, so traffic switches as soon as it's up.
          if (next.status === 'paused' && deployment.rollback_of !== null) {
            await tx.query(
              `INSERT INTO deployments.commands (id, company_id, deployment_id, environment_id, action, status)
               SELECT $1, $2, $3, $4, 'promote', 'pending'
               WHERE NOT EXISTS (SELECT 1 FROM deployments.commands WHERE deployment_id = $3 AND action = 'promote')`,
              [randomUUID(), currentCompanyId(), deployment.id, environmentId],
            );
          }
        }
        const { rows: commands } = await tx.query<{ id: string; action: 'promote' | 'abort'; slug: string }>(
          `UPDATE deployments.commands c SET status = 'sent', updated_at = now()
           FROM deployments.deployments d JOIN catalog.applications a ON a.id = d.application_id
           WHERE c.deployment_id = d.id AND c.environment_id = $1 AND c.status = 'pending'
           RETURNING c.id, c.action, a.slug`,
          [environmentId],
        );
        return commands.map((command) => ({ id: command.id, action: command.action, namespace: command.slug, name: command.slug }));
      }),
    );
  }

  /** The agent says how a command went. */
  async commandDone(companyId: CompanyId, environmentId: string, commandValue: unknown, result: { succeeded?: unknown; message?: unknown }): Promise<void> {
    const id = parseId(commandValue, 'command');
    await runWithCompany(companyId, () =>
      this.#database.transaction((tx) =>
        tx.query(
          `UPDATE deployments.commands SET status = $3, message = $4, updated_at = now()
           WHERE id = $1 AND environment_id = $2 AND status = 'sent'`,
          [id, environmentId, result.succeeded === true ? 'done' : 'failed', typeof result.message === 'string' ? result.message.slice(0, 1000) : null],
        ),
      ),
    );
  }

  /** Fails deployments that stopped moving, in every company. */
  async failStalled(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - STALL_MINUTES * 60_000);
    const stalled = await runWithCompany(NO_COMPANY, () =>
      this.#database.transaction(async (tx) => {
        const { rows } = await tx.query<{ deployment_id: string; company_id: string }>(
          'SELECT * FROM deployments.stalled_deployments($1)',
          [cutoff],
        );
        return rows;
      }),
    );
    for (const { deployment_id: id, company_id: company } of stalled) {
      await runWithCompany(parseCompanyId(company), () =>
        this.#database.transaction(async (tx) => {
          const deployment = await findOrFail(tx, id, { lock: true });
          if (!['queued', 'committed', 'progressing'].includes(deployment.status) || deployment.updated_at >= cutoff) {
            return;
          }
          const message =
            deployment.status === 'queued'
              ? "The change couldn't be written to the environment's repository."
              : `The target didn't finish the rollout in ${STALL_MINUTES} minutes.`;
          await tx.query(
            "UPDATE deployments.deployments SET status = 'failed', message = $2, updated_at = now(), finished_at = now() WHERE id = $1",
            [id, message],
          );
          await appendToOutbox(tx, [finishedEvent(deployment, 'failed', message)]);
        }),
      );
    }
  }

  /** Files for a deployment's version, with the environment's values as they are now. */
  async #render(tx: TenantTransaction, deployment: Row): Promise<Map<string, string>> {
    const environment = await findEnvironment(tx, deployment.environment_id);
    const { rows: builds } = await tx.query<{ image_ref: string; digest: string }>(
      'SELECT image_ref, digest FROM builds.builds WHERE id = $1',
      [deployment.build_id],
    );
    const { rows: repositories } = await tx.query<{ blueprint_key: string | null; blueprint_version: string | null }>(
      'SELECT blueprint_key, blueprint_version FROM source.repositories WHERE application_id = $1',
      [deployment.application_id],
    );
    const blueprint = repositories[0]?.blueprint_key && repositories[0].blueprint_version
      ? this.#blueprints.manifest(repositories[0].blueprint_key, repositories[0].blueprint_version)
      : null;
    const runtime: Runtime = blueprint === null ? DEFAULT_RUNTIME : blueprint.runtime;
    const config = await this.#config.resolve(tx, deployment.environment_id, {
      id: deployment.application_id,
      slug: deployment.application_slug,
    });
    // Images are named as targets pull them, and by digest.
    const path = builds[0]!.image_ref.replace(/^[^/]+\//, '').replace(/:[^/:]+$/, '');
    return renderApplication({
      deploymentId: deployment.id,
      application: { slug: deployment.application_slug, name: deployment.application_name },
      environment: { slug: environment.slug, kind: environment.kind },
      image: `${this.#options.targetRegistryHost}/${path}@${builds[0]!.digest}`,
      version: deployment.build_version ?? deployment.image_tag,
      strategy: deployment.strategy,
      runtime,
      variables: config.variables,
      secretPaths: [
        ...(config.hasSharedSecrets ? [config.secretPaths.shared] : []),
        ...(config.hasApplicationSecrets ? [config.secretPaths.application] : []),
      ],
    });
  }

  /** Replaces an application's folder with these files, and updates the root list. */
  async #write(
    repository: Awaited<ReturnType<TargetConfigurations['repositoryOf']>>,
    deployment: Row,
    files: Map<string, string>,
    message: string,
  ): Promise<string> {
    const folder = applicationFolder(deployment.application_slug);
    const existing = await this.#repositories.readFolder(repository, folder);
    const deployed = await this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<{ slug: string }>(
        `SELECT DISTINCT a.slug FROM deployments.deployments d JOIN catalog.applications a ON a.id = d.application_id
         WHERE d.environment_id = $1 AND d.commit_sha IS NOT NULL AND a.id <> $2`,
        [deployment.environment_id, deployment.application_id],
      );
      return rows.map((row) => row.slug);
    });
    const changes: FileChange[] = [
      ...[...existing.keys()].filter((path) => !files.has(path)).map((path) => ({ path, content: null })),
      ...[...files].map(([path, content]) => ({ path, content })),
      { path: 'kustomization.yaml', content: renderRoot(files.size > 0 ? [...deployed, deployment.application_slug] : deployed) },
    ];
    return this.#repositories.commit(repository, message, changes);
  }
}

/** Only people who may deploy to an environment's kind can deploy there, or steer a rollout. */
function assertMayDeploy(actor: Principal, kind: 'test' | 'production'): void {
  const permission = kind === 'production' ? 'deployments-production:run' : 'deployments-test:run';
  if (!actor.permissions.includes(permission)) {
    throw new DeploymentError(
      'forbidden',
      kind === 'production' ? 'Only Tech Leads and Operators deploy to production.' : "You can't deploy to test environments.",
    );
  }
}

function queued(deploymentId: string, actorId: string) {
  return createDomainEvent({ eventType: 'DeploymentQueued', companyId: currentCompanyId(), actorId, payload: { deploymentId } });
}

function finishedEvent(deployment: Row, status: DeploymentStatus, message: string | null) {
  const eventType = status === 'succeeded' ? 'DeploymentSucceeded' : status === 'aborted' ? 'DeploymentAborted' : 'DeploymentFailed';
  return createDomainEvent({
    eventType,
    companyId: currentCompanyId(),
    actorId: null,
    payload: {
      deploymentId: deployment.id,
      applicationId: deployment.application_id,
      applicationName: deployment.application_name,
      environmentId: deployment.environment_id,
      environmentName: deployment.environment_name,
      version: deployment.build_version ?? deployment.image_tag,
      ...(message !== null && status !== 'succeeded' && { reason: message }),
    },
  });
}

/** The newest deployment of the same application and environment that ran well, before this one. */
async function previousSuccess(tx: TenantTransaction, deployment: Row): Promise<Row | null> {
  const { rows } = await tx.query<Row>(
    `${SELECT} WHERE d.environment_id = $1 AND d.application_id = $2 AND d.status IN ('succeeded', 'superseded')
       AND d.created_at < $3 AND d.build_id <> $4
     ORDER BY d.created_at DESC LIMIT 1`,
    [deployment.environment_id, deployment.application_id, deployment.created_at, deployment.build_id],
  );
  return rows[0] ?? null;
}

async function findOrFail(tx: TenantTransaction, id: string, options: { lock?: boolean } = {}): Promise<Row> {
  if (options.lock) {
    await tx.query('SELECT 1 FROM deployments.deployments WHERE id = $1 FOR UPDATE', [id]);
  }
  const { rows } = await tx.query<Row>(`${SELECT} WHERE d.id = $1`, [id]);
  if (rows[0] === undefined) {
    throw new DeploymentError('not-found', 'This deployment does not exist.');
  }
  return rows[0];
}

async function findEnvironment(tx: TenantTransaction, id: string): Promise<EnvironmentRow> {
  const { rows } = await tx.query<EnvironmentRow>(
    'SELECT id, name, slug, kind, accepts_feature_images, requires_approval, status FROM environments.environments WHERE id = $1',
    [id],
  );
  if (rows[0] === undefined) {
    throw new DeploymentError('not-found', 'This environment does not exist.');
  }
  return rows[0];
}

function parseId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new DeploymentError('invalid', `The ${what} ID is not valid.`);
  }
  return value;
}

const PHASES = new Set(['Progressing', 'Paused', 'Healthy', 'Degraded', 'Aborted']);

/** Agents are trusted to report only on their own environment, and only in this shape. */
function parseWorkloads(value: unknown): WorkloadReport[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const count = (input: unknown) => (typeof input === 'number' && Number.isInteger(input) && input >= 0 && input < 10_000 ? input : 0);
  return value.slice(0, 500).flatMap((item) => {
    const workload = item as Record<string, unknown>;
    if (typeof workload.deploymentId !== 'string' || !UUID_PATTERN.test(workload.deploymentId) || !PHASES.has(String(workload.phase))) {
      return [];
    }
    return [
      {
        deploymentId: workload.deploymentId,
        phase: workload.phase as WorkloadReport['phase'],
        desired: count(workload.desired),
        updated: count(workload.updated),
        ready: count(workload.ready),
        available: count(workload.available),
        message: typeof workload.message === 'string' ? workload.message.slice(0, 500) : null,
      },
    ];
  });
}

function parseSync(value: unknown): SyncReport | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const sync = value as Record<string, unknown>;
  return {
    revision: typeof sync.revision === 'string' && /^[0-9a-f]{40,64}$/.test(sync.revision) ? sync.revision : null,
    ready: sync.ready === true,
    message: typeof sync.message === 'string' ? sync.message.slice(0, 500) : null,
  };
}

function toView(row: Row): DeploymentView {
  return {
    id: row.id,
    application: { id: row.application_id, name: row.application_name, slug: row.application_slug },
    environment: { id: row.environment_id, name: row.environment_name, kind: row.environment_kind },
    version: { buildId: row.build_id, kind: row.build_kind, tag: row.image_tag, version: row.build_version },
    strategy: row.strategy,
    status: row.status,
    message: row.message,
    progress: row.progress,
    rollbackOf: row.rollback_of,
    commit: row.commit_sha,
    requestedBy: row.requested_by === null ? null : { userId: row.requested_by, displayName: row.requester_name },
    approvedBy: row.approved_by === null ? null : { userId: row.approved_by, displayName: row.approver_name },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}
