import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { type CompanyId, createDomainEvent, currentCompanyId, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { BlueprintCatalog } from '../../blueprints/application/blueprint-catalog.ts';
import type { Builds, BuildView } from '../../builds/application/builds.ts';
import type { ApplicationCatalog, ApplicationView } from '../../catalog/application/application-catalog.ts';
import type { Entitlements } from '../../editions/application/entitlements.ts';
import type { EnvironmentConfig } from '../../environments/application/environment-config.ts';
import type { Environments, EnvironmentView } from '../../environments/application/environments.ts';
import { authorizeChange, type ProtectedChange } from '../../environments/domain/protection.ts';
import { withTelemetry } from '../../environments/domain/telemetry.ts';
import { LOCAL_PROVIDER } from '../../environments/domain/hosting-providers.ts';
import { platformVariables } from '../../environments/domain/variables.ts';
import type { EnvironmentRepositories, FileChange } from '../../environments/application/ports.ts';
import type { TargetConfigurations } from '../../environments/application/target-configuration.ts';
import type { Principal } from '../../identity-access/domain/access.ts';
import type { RepositoryLookup } from '../../source-governance/application/repository-lookup.ts';
import { type HostRuntime, type HostTarget, type LogEntry, PermanentDeploymentError } from './ports.ts';
import {
  advance,
  assertAccepts,
  type DeploymentStatus,
  isProgressive,
  parseStrategy,
  type Progress,
  advanceStop,
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
  /** What it does: run a version, remove what runs, or run it again with the values as they are now. */
  readonly action: DeploymentAction;
  /** Why it was asked for, as typed. */
  readonly reason: string | null;
  /** The CPU and memory the version runs with, once it's committed, such as { cpu: '250m', memory: '256Mi' }. */
  readonly limits: ResourceLimits | null;
}

export type DeploymentAction = 'deploy' | 'stop' | 'apply';

/** A version that runs in an environment now, with what it runs with. */
export interface RunningVersion {
  readonly deploymentId: string;
  readonly application: { readonly id: string; readonly name: string; readonly slug: string };
  readonly environment: { readonly id: string; readonly name: string; readonly kind: 'test' | 'production' };
  readonly version: { readonly buildId: string; readonly kind: string; readonly tag: string; readonly version: string | null };
  readonly strategy: Strategy;
  readonly limits: ResourceLimits | null;
  /** When it started running. */
  readonly since: string | null;
  /** What runs the environment, such as kubernetes or local for This machine. */
  readonly provider: string | null;
  /** Where people reach it, when the platform knows, such as on This machine. */
  readonly address: string | null;
  /** The environment's values changed since it started, so Apply now would start it with the new ones. */
  readonly settingsChanged: boolean;
}

/**
 * The resources a version runs with: the CPU it's guaranteed, and the most memory it may
 * use, in Kubernetes' units.
 */
export interface ResourceLimits {
  readonly cpu: string;
  readonly memory: string;
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
  /** Where applications on targets send metrics and traces over OTLP/HTTP, or null for nowhere. */
  readonly targetOtlpEndpoint: string | null;
  /** How long a new version on This machine has to become healthy before it's rolled back. */
  readonly healthTimeoutMs: number;
  /** Where applications on This machine send metrics and traces over OTLP/HTTP, or null for nowhere. */
  readonly localOtlpEndpoint: string | null;
}

/** A deployment as its own table has it. */
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

/** A deployment with what other modules know of its application, environment and version. */
interface Row extends DeploymentRow {
  application_name: string;
  application_slug: string;
  environment_name: string;
  environment_kind: 'test' | 'production';
  environment_provider: string | null;
  build_kind: string;
  image_tag: string;
  build_version: string | null;
  image_ref: string | null;
  digest: string | null;
}

/** An application's container on This machine: unique there, as other companies' environments may share a short name. */
function containerName(applicationSlug: string, environment: { readonly id: string; readonly slug: string }): string {
  return `dreamdevops-${applicationSlug}-${environment.slug}-${environment.id.replaceAll('-', '').slice(0, 12)}`;
}

/** The environment repository's root list of the applications it runs. */
const ROOT_FILE = 'kustomization.yaml';

/** The applications a root list names, by short name. Without one, the environment runs nothing yet. */
function rootApplications(root: string | undefined): string[] {
  if (root === undefined) {
    return [];
  }
  const resources = (parse(root) as { resources?: unknown } | null)?.resources;
  return Array.isArray(resources)
    ? resources.flatMap((resource) => (typeof resource === 'string' && resource.startsWith('apps/') ? [resource.slice('apps/'.length)] : []))
    : [];
}

/** Deployments with the names of who asked and who approved. */
const SELECT = 'SELECT d.* FROM deployments.deployments_view() d';

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
  readonly #environments: Environments;
  readonly #applications: ApplicationCatalog;
  readonly #builds: Builds;
  readonly #sources: RepositoryLookup;
  readonly #blueprints: BlueprintCatalog;
  readonly #entitlements: Entitlements;
  readonly #options: DeploymentsOptions;
  readonly #runtime: HostRuntime;

  constructor(
    database: TenantDatabase,
    configurations: TargetConfigurations,
    repositories: EnvironmentRepositories,
    config: EnvironmentConfig,
    environments: Environments,
    applications: ApplicationCatalog,
    builds: Builds,
    sources: RepositoryLookup,
    blueprints: BlueprintCatalog,
    entitlements: Entitlements,
    runtime: HostRuntime,
    options: DeploymentsOptions,
  ) {
    this.#database = database;
    this.#runtime = runtime;
    this.#environments = environments;
    this.#applications = applications;
    this.#builds = builds;
    this.#sources = sources;
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
    const rows = await this.#database.transaction(async (tx) => {
      const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
      const { rows } = await tx.query<DeploymentRow>(`${SELECT} ${where} ORDER BY d.created_at DESC LIMIT 50`, values);
      return rows;
    });
    return (await this.#enrich(rows)).map(toView);
  }

  async get(idValue: unknown): Promise<DeploymentView> {
    const id = parseId(idValue, 'deployment');
    return toView(await this.#database.transaction((tx) => this.#findOrFail(tx, id)));
  }

  /** Asks to run a version in an environment. Production may need a second person's approval first. */
  async request(
    actor: Principal,
    applicationValue: unknown,
    input: { environment?: unknown; version?: unknown; strategy?: unknown } & Confirmed,
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
    return this.#create(actor, { applicationId, environmentId, buildId, strategy, rollbackOf: null }, 'deploy', input);
  }

  async #create(
    actor: Principal,
    input: { applicationId: string; environmentId: string; buildId: string; strategy: Strategy; rollbackOf: string | null },
    change: ProtectedChange,
    request: Confirmed,
  ): Promise<DeploymentView> {
    const id = randomUUID();
    const environment = await this.#environments.get(input.environmentId);
    assertMayDeploy(actor, environment.kind);
    const reason = authorize(environment, change, request);
    const action: DeploymentAction = change === 'stop' ? 'stop' : change === 'apply' ? 'apply' : 'deploy';
    if (environment.status !== 'active') {
      throw new DeploymentError('conflict', 'Restore the environment first.');
    }
    const application = await this.#applications.get(input.applicationId);
    // What runs of an archived application can still be stopped.
    if (application.status !== 'active' && action !== 'stop') {
      throw new DeploymentError('conflict', 'Restore the application first.');
    }
    const build = (await this.#builds.many([input.buildId])).get(input.buildId);
    if (build === undefined || build.applicationId !== input.applicationId) {
      throw new DeploymentError('not-found', 'This version does not exist.');
    }
    // A stop removes what runs, whatever it is. Everything else must be a version the environment takes.
    if (action !== 'stop') {
      assertAccepts(environment, build);
    }
    if (environment.target?.provider === LOCAL_PROVIDER && !['recreate', 'rolling'].includes(input.strategy)) {
      throw new DeploymentError('invalid', 'This machine runs one copy of each application: choose rolling or recreate.');
    }
    if (environment.target?.status !== 'connected') {
      throw new DeploymentError(
        'conflict',
        environment.target?.status === 'lost'
          ? `The target of ${environment.name} isn't reporting, so nothing can be deployed there now.`
          : `${environment.name} has no connected target yet.`,
      );
    }
    await this.#database.transaction(async (tx) => {
      // Rollbacks, stops and applying values run or remove a version that already ran, so they don't wait for approval.
      const needsApproval = environment.requiresApproval && change === 'deploy';
      const status: DeploymentStatus = needsApproval ? 'awaiting-approval' : 'queued';
      try {
        await tx.query(
          `INSERT INTO deployments.deployments
             (id, company_id, environment_id, application_id, build_id, strategy, status, rollback_of, requested_by, reason, action)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [id, currentCompanyId(), input.environmentId, input.applicationId, input.buildId, input.strategy, status, input.rollbackOf, actor.userId, reason, action],
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
            action,
            needsApproval,
            ...(reason !== null && { reason }),
          },
        }),
        ...(needsApproval ? [] : [queued(id, actor.userId)]),
      ]);
    });
    return this.get(id);
  }

  /**
   * Removes what runs of an application in an environment. Its resources go when the
   * target applies the change. Production needs its name and a reason.
   */
  async stop(actor: Principal, applicationValue: unknown, input: { environment?: unknown } & Confirmed): Promise<DeploymentView> {
    const running = await this.#running(applicationValue, input.environment, 'stop');
    return this.#create(
      actor,
      { applicationId: running.application_id, environmentId: running.environment_id, buildId: running.build_id, strategy: running.strategy, rollbackOf: null },
      'stop',
      input,
    );
  }

  /**
   * Runs what runs again, so it starts with the environment's values as they are now.
   * Values apply only when a version starts, so this is how a change reaches it.
   */
  async apply(actor: Principal, applicationValue: unknown, input: { environment?: unknown } & Confirmed): Promise<DeploymentView> {
    const running = await this.#running(applicationValue, input.environment, 'apply');
    return this.#create(
      actor,
      { applicationId: running.application_id, environmentId: running.environment_id, buildId: running.build_id, strategy: running.strategy, rollbackOf: null },
      'apply',
      input,
    );
  }

  /** What runs now, by environment or application, with whether the environment's values changed since. */
  async running(filter: { application?: unknown; environment?: unknown }): Promise<RunningVersion[]> {
    const conditions = ["d.status = 'succeeded'", "d.action <> 'stop'"];
    const values: string[] = [];
    if (filter.application !== undefined && filter.application !== '') {
      values.push(parseId(filter.application, 'application'));
      conditions.push(`d.application_id = $${values.length}`);
    }
    if (filter.environment !== undefined && filter.environment !== '') {
      values.push(parseId(filter.environment, 'environment'));
      conditions.push(`d.environment_id = $${values.length}`);
    }
    const { rows, hashes } = await this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<DeploymentRow>(`${SELECT} WHERE ${conditions.join(' AND ')} ORDER BY d.finished_at DESC`, values);
      const hashes = await Promise.all(rows.map((row) => this.#config.fingerprint(tx, row.environment_id, row.application_id)));
      return { rows, hashes };
    });
    return (await this.#enrich(rows)).map((row, index) => ({
      deploymentId: row.id,
      application: { id: row.application_id, name: row.application_name, slug: row.application_slug },
      environment: { id: row.environment_id, name: row.environment_name, kind: row.environment_kind },
      version: { buildId: row.build_id, kind: row.build_kind, tag: row.image_tag, version: row.build_version },
      strategy: row.strategy,
      limits: row.limits,
      since: row.finished_at?.toISOString() ?? null,
      provider: row.environment_provider,
      address: row.progress.address ?? null,
      settingsChanged: row.config_hash !== null && row.config_hash !== hashes[index],
    }));
  }

  /** The deployment that runs an application in an environment now. */
  async #running(applicationValue: unknown, environmentValue: unknown, change: 'stop' | 'apply'): Promise<Row> {
    const applicationId = parseId(applicationValue, 'application');
    const environmentId = parseId(environmentValue, 'environment');
    const rows = await this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<DeploymentRow>(
        `${SELECT} WHERE d.environment_id = $1 AND d.application_id = $2 AND d.status = 'succeeded' AND d.action <> 'stop'`,
        [environmentId, applicationId],
      );
      return rows;
    });
    const running = (await this.#enrich(rows))[0];
    if (running === undefined) {
      throw new DeploymentError('conflict', change === 'stop' ? 'Nothing of this application runs there.' : 'Nothing of this application runs there to apply the values to.');
    }
    return running;
  }

  /** A second person with production rights approves; the one who asked can't. */
  approve(actor: Principal, idValue: unknown, request: Confirmed = {}): Promise<void> {
    return this.#decide(actor, idValue, true, request);
  }

  /** Refusing is always safe, so it needs no confirmation. */
  reject(actor: Principal, idValue: unknown): Promise<void> {
    return this.#decide(actor, idValue, false, {});
  }

  #decide(actor: Principal, idValue: unknown, approved: boolean, request: Confirmed): Promise<void> {
    const id = parseId(idValue, 'deployment');
    return this.#database.transaction(async (tx) => {
      const deployment = await this.#findOrFail(tx, id, { lock: true });
      if (approved) {
        authorize({ name: deployment.environment_name, kind: deployment.environment_kind }, 'approve', request);
      }
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
    const deployment = await this.#database.transaction((tx) => this.#findOrFail(tx, idValue));
    const environment = await this.#environments.get(deployment.environment_id);
    if (environment.target?.provider === LOCAL_PROVIDER) {
      // A run that stopped half-way, such as when the API restarted, starts again from the beginning.
      if (deployment.status === 'queued' || deployment.status === 'progressing') {
        await this.#runLocal(deployment, environment);
      }
      return;
    }
    if (deployment.status !== 'queued') {
      return;
    }
    const repository = await this.#configurations.repositoryOf(deployment.environment_id);
    const version = deployment.build_version ?? deployment.image_tag;
    const rendered =
      deployment.action === 'stop'
        ? { files: new Map<string, string>(), limits: null, configHash: null }
        : await this.#database.transaction(async (tx) => ({
            ...(await this.#render(tx, deployment)),
            configHash: await this.#config.fingerprint(tx, deployment.environment_id, deployment.application_id),
          }));
    const message =
      deployment.action === 'stop'
        ? `Stop ${deployment.application_slug}`
        : deployment.action === 'apply'
          ? `Apply ${deployment.application_slug}'s values to ${version}`
          : `Deploy ${deployment.application_slug} ${version} with ${deployment.strategy}`;
    const sha = await this.#write(repository, deployment, rendered.files, message);
    await this.#database.transaction(async (tx) => {
      // The limits and values are recorded as committed, so what it runs with is known later, such as by Monitoring.
      const { rowCount } = await tx.query(
        `UPDATE deployments.deployments
         SET status = 'committed', commit_sha = $2, limits = $3, config_hash = $4, message = NULL, updated_at = now()
         WHERE id = $1 AND status = 'queued'`,
        [deployment.id, sha, rendered.limits === null ? null : JSON.stringify(rendered.limits), rendered.configHash],
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
    const deployment = await this.#database.transaction((tx) => this.#findOrFail(tx, idValue));
    if ((await this.#environments.get(deployment.environment_id)).target?.provider === LOCAL_PROVIDER) {
      // This machine's runtime has put the version before back already.
      return;
    }
    const previous = await this.#database.transaction((tx) => this.#previousSuccess(tx, deployment, { otherVersion: false }));
    const repository = await this.#configurations.repositoryOf(deployment.environment_id);
    if (previous === null) {
      // Nothing ran here before: the application's folder goes, and with it what was applied.
      await this.#write(repository, deployment, new Map(), `Remove ${deployment.application_slug}: its first deployment did not succeed`);
      return;
    }
    const { files } = await this.#database.transaction((tx) => this.#render(tx, previous));
    await this.#write(repository, previous, files, `Restore ${previous.application_slug} ${previous.build_version ?? previous.image_tag}`);
  }

  /** Switches traffic to a blue/green deployment's new version. */
  promote(actor: Principal, idValue: unknown, request: Confirmed = {}): Promise<void> {
    return this.#command(actor, idValue, 'promote', request, (deployment) => {
      if (deployment.status !== 'paused') {
        throw new DeploymentError('conflict', 'Only a blue/green deployment waiting on its preview can be promoted.');
      }
    });
  }

  /** Stops a rolling or blue/green rollout and returns traffic to the previous version. */
  abort(actor: Principal, idValue: unknown, request: Confirmed = {}): Promise<void> {
    return this.#command(actor, idValue, 'abort', request, (deployment) => {
      if (deployment.strategy === 'recreate') {
        throw new DeploymentError('conflict', "A recreate deployment can't be aborted. Roll it back instead.");
      }
      if (deployment.status !== 'progressing' && deployment.status !== 'paused') {
        throw new DeploymentError('conflict', 'Only a rollout in progress can be aborted.');
      }
    });
  }

  /** Runs the last version that ran well before this one, with the same strategy. */
  async rollback(actor: Principal, idValue: unknown, request: Confirmed = {}): Promise<DeploymentView> {
    const id = parseId(idValue, 'deployment');
    const { deployment, previous } = await this.#database.transaction(async (tx) => {
      const deployment = await this.#findOrFail(tx, id);
      return { deployment, previous: await this.#previousSuccess(tx, deployment, { otherVersion: true }) };
    });
    if (deployment.action === 'stop') {
      throw new DeploymentError('conflict', 'A stop has nothing to roll back. Deploy a version to run one again.');
    }
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
    }, 'rollback', request);
  }

  async #command(
    actor: Principal,
    idValue: unknown,
    action: 'promote' | 'abort',
    request: Confirmed,
    check: (deployment: Row) => void,
  ): Promise<void> {
    const id = parseId(idValue, 'deployment');
    await this.#database.transaction(async (tx) => {
      const deployment = await this.#findOrFail(tx, id, { lock: true });
      assertMayDeploy(actor, deployment.environment_kind);
      check(deployment);
      authorize({ name: deployment.environment_name, kind: deployment.environment_kind }, action, request);
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
        const { rows } = await tx.query<DeploymentRow>(
          `${SELECT} WHERE d.environment_id = $1 AND d.status = ANY($2)`,
          [environmentId, ROLLING_OUT],
        );
        // Which application each reported workload belongs to, for stops, which have none of their own.
        const { rows: reported } = await tx.query<{ application_id: string }>(
          'SELECT DISTINCT application_id FROM deployments.deployments WHERE id = ANY($1)',
          [workloads.map((workload) => workload.deploymentId)],
        );
        const running = new Set(reported.map((row) => row.application_id));
        for (const deployment of await this.#enrich(rows)) {
          const next =
            deployment.action === 'stop'
              ? advanceStop(deployment, running.has(deployment.application_id), sync)
              : advance(
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
        const { rows: commands } = await tx.query<{ id: string; action: 'promote' | 'abort'; application_id: string }>(
          `UPDATE deployments.commands c SET status = 'sent', updated_at = now()
           FROM deployments.deployments d
           WHERE c.deployment_id = d.id AND c.environment_id = $1 AND c.status = 'pending'
           RETURNING c.id, c.action, d.application_id`,
          [environmentId],
        );
        const applications = await this.#applicationsById(commands.map((command) => command.application_id));
        return commands.map((command) => {
          // Each application runs in a namespace named after it, as its rollout is.
          const slug = applications.get(command.application_id)!.slug;
          return { id: command.id, action: command.action, namespace: slug, name: slug };
        });
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
          const deployment = await this.#findOrFail(tx, id, { lock: true });
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

  /**
   * Runs a deployment on This machine: checks the image's signature, pulls it by digest,
   * starts it with the environment's values, and waits until it's healthy. If it isn't,
   * the version before it runs again.
   */
  async #runLocal(deployment: Row, environment: EnvironmentView): Promise<void> {
    const target: HostTarget = { id: environment.target!.id, settings: environment.target!.settings };
    // Unique on the machine: environments of other companies may share a short name.
    const name = containerName(deployment.application_slug, environment);
    const network = `${name}-net`;
    const step = (message: string, progress: Progress = { applied: false }) =>
      this.#database.transaction((tx) =>
        tx.query(
          `UPDATE deployments.deployments SET status = 'progressing', progress = $2, message = $3, updated_at = now()
           WHERE id = $1 AND status IN ('queued', 'progressing')`,
          [deployment.id, JSON.stringify(progress), message],
        ),
      );
    const unavailable = this.#runtime.unavailableReason();
    if (unavailable !== null) {
      await this.#finishLocal(deployment, 'failed', unavailable, null);
      return;
    }
    try {
      if (deployment.action === 'stop') {
        await step('Removing it from this machine.');
        await this.#runtime.remove(target, name, network);
        await this.#finishLocal(deployment, 'succeeded', 'It no longer runs here.', null);
        return;
      }
      await step('Checking the image’s signature.');
      const signature = await this.#builds.checkSignature(deployment.build_id);
      const unsigned = signature.checks.find((check) => check.outcome === 'failed');
      if (unsigned !== undefined) {
        await this.#finishLocal(deployment, 'failed', `${unsigned.name}: ${unsigned.detail ?? 'no'}. Nothing was pulled.`, null);
        return;
      }
      // By digest, so what runs is exactly what was built, scanned and signed.
      const image = `${deployment.image_ref!.replace(/:[^/:]+$/, '')}@${deployment.digest}`;
      await step('Pulling the image.');
      await this.#runtime.pull(target, image);
      const settings = await this.#database.transaction(async (tx) => ({
        runtime: await this.#runtimeOf(deployment.application_id),
        config: await this.#config.resolve(tx, deployment.environment_id, { id: deployment.application_id, slug: deployment.application_slug }),
        configHash: await this.#config.fingerprint(tx, deployment.environment_id, deployment.application_id),
        preferredPort: await this.#lastPort(tx, deployment),
      }));
      const secrets = await this.#config.openSecrets(deployment.environment_id, deployment.application_slug);
      await step('Starting the new version.');
      const started = await this.#runtime.start(target, {
        name,
        network,
        image,
        labels: {
          'dreamdevops.company': currentCompanyId(),
          'dreamdevops.application': deployment.application_slug,
          'dreamdevops.environment': environment.slug,
          'dreamdevops.deployment': deployment.id,
          'dreamdevops.version': deployment.build_version ?? deployment.image_tag,
        },
        environment: {
          // On This machine, applications send straight to the platform's collector.
          ...withTelemetry(settings.config.variables, {
            environmentId: deployment.environment_id,
            applicationId: deployment.application_id,
            serviceName: deployment.application_slug,
            metricsEndpoint: this.#options.localOtlpEndpoint === null ? null : `${this.#options.localOtlpEndpoint}/v1/metrics`,
            tracesEndpoint: this.#options.localOtlpEndpoint === null ? null : `${this.#options.localOtlpEndpoint}/v1/traces`,
          }),
          ...secrets,
          PORT: String(settings.runtime.port),
          ...platformVariables({ slug: environment.slug, production: environment.kind === 'production' }, deployment.build_version ?? deployment.image_tag),
        },
        preferredPort: settings.preferredPort,
      });
      const progress: Progress = { applied: true, address: started.address, port: started.port };
      await step('Waiting until it’s healthy.', progress);
      const health = await this.#runtime.waitUntilHealthy(target, name, this.#options.healthTimeoutMs);
      if (!health.healthy) {
        const back = await this.#runtime.rollBack(target, name);
        await this.#finishLocal(
          deployment,
          'failed',
          `${health.detail} ${back ? 'The version before runs again.' : 'Nothing runs now.'}`,
          null,
          progress,
        );
        return;
      }
      await this.#runtime.commit(target, name);
      const limits: ResourceLimits = {
        cpu: String(started.limits.cpus),
        memory: `${Math.round(started.limits.memoryBytes / (1024 * 1024))}Mi`,
      };
      await this.#finishLocal(
        deployment,
        'succeeded',
        started.address === null ? 'It runs.' : `It runs at ${started.address}.`,
        { limits, configHash: settings.configHash },
        progress,
      );
    } catch (error) {
      if (error instanceof PermanentDeploymentError) {
        await this.#finishLocal(deployment, 'failed', error.message, null);
        return;
      }
      // A temporary problem, such as Docker restarting: the job runs it again from the start.
      throw error;
    }
  }

  /**
   * The latest lines an application on This machine wrote, or null when it doesn't run on
   * This machine. Clusters' logs go to the platform's log store instead.
   */
  async localLogs(
    environmentId: string,
    applicationId: string,
    options: { readonly since: Date; readonly limit: number },
  ): Promise<LogEntry[] | null> {
    const environment = await this.#environments.get(environmentId);
    if (environment.target?.provider !== LOCAL_PROVIDER) {
      return null;
    }
    const application = await this.#applications.get(applicationId);
    const target: HostTarget = { id: environment.target.id, settings: environment.target.settings };
    return this.#runtime.logs(target, containerName(application.slug, environment), options);
  }

  /** Records how a run on This machine ended, as the agent's reports do for clusters. */
  async #finishLocal(
    deployment: Row,
    status: 'succeeded' | 'failed',
    message: string,
    recorded: { limits: ResourceLimits; configHash: string } | null,
    progress: Progress = { applied: status === 'succeeded' },
  ): Promise<void> {
    await this.#database.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE deployments.deployments
         SET status = $2, message = $3, progress = $4, limits = coalesce($5, limits), config_hash = coalesce($6, config_hash),
             finished_at = now(), updated_at = now()
         WHERE id = $1 AND status IN ('queued', 'progressing')`,
        [
          deployment.id,
          status,
          message.slice(0, 1000),
          JSON.stringify(progress),
          recorded === null ? null : JSON.stringify(recorded.limits),
          recorded?.configHash ?? null,
        ],
      );
      if (rowCount === 0) {
        return;
      }
      await appendToOutbox(tx, [finishedEvent(deployment, status, status === 'succeeded' ? null : message)]);
      if (status === 'succeeded') {
        await tx.query(
          `UPDATE deployments.deployments SET status = 'superseded', updated_at = now()
           WHERE environment_id = $1 AND application_id = $2 AND status = 'succeeded' AND id <> $3`,
          [deployment.environment_id, deployment.application_id, deployment.id],
        );
      }
    });
  }

  /** The port the application had on This machine, so its address stays the same. */
  async #lastPort(tx: TenantTransaction, deployment: Row): Promise<number | null> {
    const { rows } = await tx.query<{ port: number | null }>(
      `SELECT (progress->>'port')::int AS port FROM deployments.deployments
       WHERE environment_id = $1 AND application_id = $2 AND status IN ('succeeded', 'superseded') AND progress ? 'port'
       ORDER BY finished_at DESC LIMIT 1`,
      [deployment.environment_id, deployment.application_id],
    );
    return rows[0]?.port ?? null;
  }

  /** The settings of the blueprint version an application started from, such as its port. */
  async #runtimeOf(applicationId: string): Promise<Runtime> {
    const source = (await this.#sources.find(applicationId))?.blueprint ?? null;
    const blueprint = source === null ? null : this.#blueprints.manifest(source.key, source.version);
    return blueprint === null ? DEFAULT_RUNTIME : blueprint.runtime;
  }

  /** Files for a deployment's version, with the environment's values as they are now. */
  async #render(tx: TenantTransaction, deployment: Row): Promise<{ files: Map<string, string>; limits: ResourceLimits }> {
    const environment = await this.#environments.get(deployment.environment_id);
    // The application runs with the settings of the blueprint version it started from.
    const source = (await this.#sources.find(deployment.application_id))?.blueprint ?? null;
    const blueprint = source === null ? null : this.#blueprints.manifest(source.key, source.version);
    const runtime: Runtime = blueprint === null ? DEFAULT_RUNTIME : blueprint.runtime;
    const config = await this.#config.resolve(tx, deployment.environment_id, {
      id: deployment.application_id,
      slug: deployment.application_slug,
    });
    // Images are named as targets pull them, and by digest.
    const path = deployment.image_ref!.replace(/^[^/]+\//, '').replace(/:[^/:]+$/, '');
    const files = renderApplication({
      deploymentId: deployment.id,
      application: { slug: deployment.application_slug, name: deployment.application_name },
      environment: { slug: environment.slug, kind: environment.kind },
      image: `${this.#options.targetRegistryHost}/${path}@${deployment.digest}`,
      version: deployment.build_version ?? deployment.image_tag,
      strategy: deployment.strategy,
      runtime,
      // The standard OpenTelemetry settings, so the application's metrics and traces reach the platform.
      variables: withTelemetry(config.variables, {
        environmentId: deployment.environment_id,
        applicationId: deployment.application_id,
        serviceName: deployment.application_slug,
        metricsEndpoint: this.#options.targetOtlpEndpoint === null ? null : `${this.#options.targetOtlpEndpoint}/v1/metrics`,
        tracesEndpoint: this.#options.targetOtlpEndpoint === null ? null : `${this.#options.targetOtlpEndpoint}/v1/traces`,
      }),
      secretPaths: [
        ...(config.hasSharedSecrets ? [config.secretPaths.shared] : []),
        ...(config.hasApplicationSecrets ? [config.secretPaths.application] : []),
      ],
    });
    return { files, limits: { cpu: runtime.resources.cpu, memory: runtime.resources.memory } };
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
    // The applications the environment runs are the root's list, as it is in the repository.
    const root = (await this.#repositories.readFolder(repository, ROOT_FILE)).get(ROOT_FILE);
    const others = rootApplications(root).filter((slug) => slug !== deployment.application_slug);
    const changes: FileChange[] = [
      ...[...existing.keys()].filter((path) => !files.has(path)).map((path) => ({ path, content: null })),
      ...[...files].map(([path, content]) => ({ path, content })),
      { path: ROOT_FILE, content: renderRoot(files.size > 0 ? [...others, deployment.application_slug] : others) },
    ];
    return this.#repositories.commit(repository, message, changes);
  }

  /** The newest deployment of the same application and environment that ran well, before this one. */
  /**
   * What ran well before a deployment: for a rollback, the version before it; to restore
   * after a failure, whatever ran last, which may be the same version with older values.
   */
  async #previousSuccess(tx: TenantTransaction, deployment: Row, options: { otherVersion: boolean }): Promise<Row | null> {
    const { rows } = await tx.query<DeploymentRow>(
      `${SELECT} WHERE d.environment_id = $1 AND d.application_id = $2 AND d.status IN ('succeeded', 'superseded')
         AND d.action <> 'stop' AND d.created_at < $3 AND ($5 = false OR d.build_id <> $4)
       ORDER BY d.created_at DESC LIMIT 1`,
      [deployment.environment_id, deployment.application_id, deployment.created_at, deployment.build_id, options.otherVersion],
    );
    return (await this.#enrich(rows))[0] ?? null;
  }

  async #findOrFail(tx: TenantTransaction, id: string, options: { lock?: boolean } = {}): Promise<Row> {
    if (options.lock) {
      await tx.query('SELECT 1 FROM deployments.deployments WHERE id = $1 FOR UPDATE', [id]);
    }
    const { rows } = await tx.query<DeploymentRow>(`${SELECT} WHERE d.id = $1`, [id]);
    if (rows[0] === undefined) {
      throw new DeploymentError('not-found', 'This deployment does not exist.');
    }
    return (await this.#enrich(rows))[0]!;
  }

  /**
   * Adds what the catalog, environments and builds know of each deployment. They keep
   * their own tables, so this asks them, once per application, environment and version.
   */
  async #enrich(rows: readonly DeploymentRow[]): Promise<Row[]> {
    if (rows.length === 0) {
      return [];
    }
    const unique = (pick: (row: DeploymentRow) => string) => [...new Set(rows.map(pick))];
    const [applications, environments, builds] = await Promise.all([
      this.#applicationsById(unique((row) => row.application_id)),
      Promise.all(unique((row) => row.environment_id).map((id) => this.#environments.get(id))).then(
        (views) => new Map<string, EnvironmentView>(views.map((view) => [view.id, view])),
      ),
      this.#builds.many(unique((row) => row.build_id)),
    ]);
    return rows.map((row) => {
      const application = applications.get(row.application_id)!;
      const environment = environments.get(row.environment_id)!;
      const build: BuildView = builds.get(row.build_id)!;
      return {
        ...row,
        application_name: application.name,
        application_slug: application.slug,
        environment_name: environment.name,
        environment_kind: environment.kind,
        environment_provider: environment.target?.provider ?? null,
        build_kind: build.kind,
        image_tag: build.tag,
        build_version: build.version,
        image_ref: build.imageRef,
        digest: build.digest,
      };
    });
  }

  async #applicationsById(ids: readonly string[]): Promise<Map<string, ApplicationView>> {
    const views = await Promise.all([...new Set(ids)].map((id) => this.#applications.get(id)));
    return new Map(views.map((view) => [view.id, view]));
  }
}

/** What a change to production carries: its name, typed to confirm, and why. */
export interface Confirmed {
  readonly confirmation?: unknown;
  readonly reason?: unknown;
}

/**
 * Production's protection: its name typed exactly, and for rollbacks and stops, a reason.
 * Who may deploy there is checked apart, by the permission to deploy.
 */
function authorize(environment: { readonly name: string; readonly kind: 'test' | 'production' }, change: ProtectedChange, request: Confirmed): string | null {
  return authorizeChange({ name: environment.name, production: environment.kind === 'production' }, change, {
    canManageProduction: false,
    confirmation: request.confirmation,
    reason: request.reason,
  });
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
  return createDomainEvent({
    eventType: status === 'succeeded' ? 'DeploymentSucceeded' : status === 'aborted' ? 'DeploymentAborted' : 'DeploymentFailed',
    companyId: currentCompanyId(),
    actorId: null,
    payload: {
      deploymentId: deployment.id,
      applicationId: deployment.application_id,
      applicationName: deployment.application_name,
      environmentId: deployment.environment_id,
      environmentName: deployment.environment_name,
      version: deployment.build_version ?? deployment.image_tag,
      action: deployment.action,
      ...(message !== null && status !== 'succeeded' && { reason: message }),
    },
  });
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
    action: row.action,
    reason: row.reason,
    limits: row.limits,
  };
}
