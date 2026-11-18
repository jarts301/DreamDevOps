import type { AgentCommand, HeartbeatResponse } from '@dreamdevops/contracts/agent/protocol';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import {
  DeploymentAborted,
  DeploymentAbortRequested,
  DeploymentApproved,
  DeploymentFailed,
  DeploymentPromoted,
  DeploymentQueued,
  DeploymentRejected,
  DeploymentRequested,
  DeploymentStarted,
  DeploymentSucceeded,
} from '@dreamdevops/contracts/deployments/events';
import { type CompanyId, currentCompanyId, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { BlueprintCatalog } from '@dreamdevops/contracts/blueprints/services';
import type { DeployableImage, DeployableImages } from '@dreamdevops/contracts/builds/services';
import { type ApplicationDirectory } from '@dreamdevops/contracts/catalog/services';
import { type ApplicationView } from '@dreamdevops/contracts/catalog/http';
import type { FeatureAccess } from '@dreamdevops/contracts/editions/services';
import type { EnvironmentView, ProductionConfirmation } from '@dreamdevops/contracts/environments/http';
import type {
  EnvironmentDirectory,
  EnvironmentGitOps,
  EnvironmentRepository,
  EnvironmentValues,
  FileChange,
  ResolvedConfig,
  TargetAuthentication,
} from '@dreamdevops/contracts/environments/services';
import { authorizeChange, type ProtectedChange } from '@dreamdevops/contracts/environments/protection';
import { withTelemetry } from '@dreamdevops/contracts/environments/telemetry';
import { LOCAL_PROVIDER } from '@dreamdevops/contracts/environments/hosting';
import { platformVariables } from '@dreamdevops/contracts/environments/variables';
import type {
  ChangeRunning,
  DeploymentAction,
  DeploymentView,
  RequestDeployment,
  ResourceLimits,
  RunningVersion,
} from '@dreamdevops/contracts/deployments/http';
import type { RunningVersions } from '@dreamdevops/contracts/deployments/services';
import type { Unchecked } from '@dreamdevops/contracts/http';
import type { Principal } from '@dreamdevops/contracts/identity-access/access';
import type { RepositoryLookup } from '@dreamdevops/contracts/source-governance/services';
import {
  type DeploymentFilter,
  type DeploymentsSession,
  type DeploymentsStore,
  type HostRuntime,
  type HostTarget,
  type LogEntry,
  PermanentDeploymentError,
  type StoredDeployment,
} from './ports.ts';
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

/** A deployment with what other modules know of its application, environment and version. */
interface KnownDeployment extends StoredDeployment {
  readonly applicationName: string;
  readonly applicationSlug: string;
  readonly environmentName: string;
  readonly environmentKind: 'test' | 'production';
  readonly environmentProvider: string | null;
  readonly buildKind: string;
  readonly imageTag: string;
  readonly buildVersion: string | null;
  readonly imageRef: string | null;
  readonly digest: string | null;
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

/**
 * Runs versions of applications in environments. A deployment is a commit to the
 * environment's repository; the target's Flux applies it, and its agent reports how the
 * rollout goes. Promote and abort reach the agent as commands with its next heartbeat.
 */
export class Deployments implements RunningVersions {
  readonly #store: DeploymentsStore;
  readonly #gitOps: EnvironmentGitOps;
  readonly #config: EnvironmentValues;
  readonly #environments: EnvironmentDirectory;
  readonly #applications: ApplicationDirectory;
  readonly #builds: DeployableImages;
  readonly #sources: RepositoryLookup;
  readonly #blueprints: BlueprintCatalog;
  readonly #entitlements: FeatureAccess;
  readonly #options: DeploymentsOptions;
  readonly #runtime: HostRuntime;
  readonly #targets: TargetAuthentication;

  constructor(
    store: DeploymentsStore,
    gitOps: EnvironmentGitOps,
    config: EnvironmentValues,
    environments: EnvironmentDirectory,
    applications: ApplicationDirectory,
    builds: DeployableImages,
    sources: RepositoryLookup,
    blueprints: BlueprintCatalog,
    entitlements: FeatureAccess,
    runtime: HostRuntime,
    targets: TargetAuthentication,
    options: DeploymentsOptions,
  ) {
    this.#store = store;
    this.#runtime = runtime;
    this.#environments = environments;
    this.#applications = applications;
    this.#builds = builds;
    this.#sources = sources;
    this.#gitOps = gitOps;
    this.#config = config;
    this.#blueprints = blueprints;
    this.#entitlements = entitlements;
    this.#options = options;
    this.#targets = targets;
  }

  /**
   * An agent reports in. Its access token says whose target it is, which Environments
   * checks; then its environment's rollouts move along, and it gets the commands waiting for it.
   */
  async agentHeartbeat(
    accessToken: string | undefined,
    report: { agentVersion?: unknown; kubernetesVersion?: unknown; sync?: unknown; workloads?: unknown },
  ): Promise<HeartbeatResponse> {
    const { heartbeatSeconds, companyId, environmentId } = await this.#targets.heartbeat(accessToken, report);
    return { heartbeatSeconds, commands: await this.#onReport(companyId, environmentId, report) };
  }

  /** An agent says how a promote or abort command went. */
  async agentCommandDone(accessToken: string | undefined, commandValue: unknown, result: { succeeded?: unknown; message?: unknown }): Promise<void> {
    const { companyId, environmentId } = await this.#targets.authenticate(accessToken);
    await this.#commandDone(companyId, environmentId, commandValue, result);
  }

  async list(filter: { application?: unknown; environment?: unknown }): Promise<DeploymentView[]> {
    const criteria = parseFilter(filter);
    const deployments = await this.#store.transaction((session) => session.list(criteria, 50));
    return (await this.#enrich(deployments)).map(toView);
  }

  async get(idValue: unknown): Promise<DeploymentView> {
    return toView(await this.#find(parseId(idValue, 'deployment')));
  }

  /** Asks to run a version in an environment. Production may need a second person's approval first. */
  async request(
    actor: Principal,
    applicationValue: unknown,
    input: Unchecked<RequestDeployment>,
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
    await this.#store.transaction(async (session) => {
      // Rollbacks, stops and applying values run or remove a version that already ran, so they don't wait for approval.
      const needsApproval = environment.requiresApproval && change === 'deploy';
      const status: DeploymentStatus = needsApproval ? 'awaiting-approval' : 'queued';
      const added = await session.add({
        id,
        environmentId: input.environmentId,
        applicationId: input.applicationId,
        buildId: input.buildId,
        strategy: input.strategy,
        status,
        rollbackOf: input.rollbackOf,
        requestedBy: actor.userId,
        reason,
        action,
      });
      if (!added) {
        throw new DeploymentError('conflict', `A deployment of this application to ${environment.name} is still going.`);
      }
      await session.record([
        DeploymentRequested.create({
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
  async stop(actor: Principal, applicationValue: unknown, input: Unchecked<ChangeRunning>): Promise<DeploymentView> {
    const running = await this.#running(applicationValue, input.environment, 'stop');
    return this.#create(
      actor,
      { applicationId: running.applicationId, environmentId: running.environmentId, buildId: running.buildId, strategy: running.strategy, rollbackOf: null },
      'stop',
      input,
    );
  }

  /**
   * Runs what runs again, so it starts with the environment's values as they are now.
   * Values apply only when a version starts, so this is how a change reaches it.
   */
  async apply(actor: Principal, applicationValue: unknown, input: Unchecked<ChangeRunning>): Promise<DeploymentView> {
    const running = await this.#running(applicationValue, input.environment, 'apply');
    return this.#create(
      actor,
      { applicationId: running.applicationId, environmentId: running.environmentId, buildId: running.buildId, strategy: running.strategy, rollbackOf: null },
      'apply',
      input,
    );
  }

  /** What runs now, by environment or application, with whether the environment's values changed since. */
  async running(filter: { application?: unknown; environment?: unknown }): Promise<RunningVersion[]> {
    const criteria = parseFilter(filter);
    const rows = await this.#store.transaction((session) => session.running(criteria));
    // The environments' values as they are now, which Environments keeps.
    const hashes = await this.#config.fingerprints(
      rows.map((row) => ({ environmentId: row.environmentId, applicationId: row.applicationId })),
    );
    return (await this.#enrich(rows)).map((row, index) => ({
      deploymentId: row.id,
      application: { id: row.applicationId, name: row.applicationName, slug: row.applicationSlug },
      environment: { id: row.environmentId, name: row.environmentName, kind: row.environmentKind },
      version: { buildId: row.buildId, kind: row.buildKind, tag: row.imageTag, version: row.buildVersion },
      strategy: row.strategy,
      limits: row.limits,
      since: row.finishedAt?.toISOString() ?? null,
      provider: row.environmentProvider,
      address: row.progress.address ?? null,
      settingsChanged: row.configHash !== null && row.configHash !== hashes[index],
    }));
  }

  /** The deployment that runs an application in an environment now. */
  async #running(applicationValue: unknown, environmentValue: unknown, change: 'stop' | 'apply'): Promise<KnownDeployment> {
    const applicationId = parseId(applicationValue, 'application');
    const environmentId = parseId(environmentValue, 'environment');
    const rows = await this.#store.transaction((session) => session.running({ applicationId, environmentId }));
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

  async #decide(actor: Principal, idValue: unknown, approved: boolean, request: Confirmed): Promise<void> {
    const id = parseId(idValue, 'deployment');
    const known = await this.#find(id);
    await this.#store.transaction(async (session) => {
      const deployment = await this.#locked(session, known);
      if (approved) {
        authorize({ name: deployment.environmentName, kind: deployment.environmentKind }, 'approve', request);
      }
      if (!actor.permissions.includes('deployments-production:run')) {
        throw new DeploymentError('forbidden', 'Only Tech Leads and Operators approve production deployments.');
      }
      if (deployment.status !== 'awaiting-approval') {
        throw new DeploymentError('conflict', 'This deployment is not waiting for approval.');
      }
      if (deployment.requestedBy === actor.userId) {
        throw new DeploymentError('forbidden', 'Someone else must approve your deployment.');
      }
      await session.decide(id, approved, actor.userId);
      await session.record([
        (approved ? DeploymentApproved : DeploymentRejected).create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { deploymentId: id, applicationId: deployment.applicationId, environmentName: deployment.environmentName },
        }),
        ...(approved ? [queued(id, actor.userId)] : []),
      ]);
    });
  }

  /** Writes the version to the environment's repository. Runs in the background. */
  async commit(idValue: string): Promise<void> {
    const deployment = await this.#find(parseId(idValue, 'deployment'));
    const environment = await this.#environments.get(deployment.environmentId);
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
    const repository = await this.#gitOps.repositoryOf(deployment.environmentId);
    const version = deployment.buildVersion ?? deployment.imageTag;
    const runtime = deployment.action === 'stop' ? null : await this.#runtimeOf(deployment.applicationId);
    const rendered =
      runtime === null
        ? { files: new Map<string, string>(), limits: null, configHash: null }
        : {
            ...this.#render(deployment, environment, runtime, await this.#valuesOf(deployment)),
            configHash: await this.#config.fingerprint(deployment.environmentId, deployment.applicationId),
          };
    const message =
      deployment.action === 'stop'
        ? `Stop ${deployment.applicationSlug}`
        : deployment.action === 'apply'
          ? `Apply ${deployment.applicationSlug}'s values to ${version}`
          : `Deploy ${deployment.applicationSlug} ${version} with ${deployment.strategy}`;
    const sha = await this.#write(repository, deployment, rendered.files, message);
    await this.#store.transaction(async (session) => {
      // The limits and values are recorded as committed, so what it runs with is known later, such as by Monitoring.
      const committed = await session.markCommitted(deployment.id, { commitSha: sha, limits: rendered.limits, configHash: rendered.configHash });
      if (!committed) {
        return;
      }
      await session.record([
        DeploymentStarted.create({
          companyId: currentCompanyId(),
          actorId: null,
          payload: { deploymentId: deployment.id, applicationId: deployment.applicationId, environmentName: deployment.environmentName, commit: sha },
        }),
      ]);
    });
  }

  /** After a failed or aborted rollout, Git goes back to the last version that ran well, so Flux keeps it. */
  async restorePrevious(idValue: string): Promise<void> {
    const deployment = await this.#find(parseId(idValue, 'deployment'));
    const environment = await this.#environments.get(deployment.environmentId);
    if (environment.target?.provider === LOCAL_PROVIDER) {
      // This machine's runtime has put the version before back already.
      return;
    }
    const previousRow = await this.#store.transaction((session) => session.previousSuccess(deployment, { otherVersion: false }));
    const repository = await this.#gitOps.repositoryOf(deployment.environmentId);
    if (previousRow === null) {
      // Nothing ran here before: the application's folder goes, and with it what was applied.
      await this.#write(repository, deployment, new Map(), `Remove ${deployment.applicationSlug}: its first deployment did not succeed`);
      return;
    }
    const previous = (await this.#enrich([previousRow]))[0]!;
    const runtime = await this.#runtimeOf(previous.applicationId);
    const { files } = this.#render(previous, environment, runtime, await this.#valuesOf(previous));
    await this.#write(repository, previous, files, `Restore ${previous.applicationSlug} ${previous.buildVersion ?? previous.imageTag}`);
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
    const deployment = await this.#find(id);
    const previous = await this.#store.transaction((session) => session.previousSuccess(deployment, { otherVersion: true }));
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
      applicationId: deployment.applicationId,
      environmentId: deployment.environmentId,
      buildId: previous.buildId,
      strategy: deployment.strategy,
      rollbackOf: deployment.id,
    }, 'rollback', request);
  }

  async #command(
    actor: Principal,
    idValue: unknown,
    action: 'promote' | 'abort',
    request: Confirmed,
    check: (deployment: KnownDeployment) => void,
  ): Promise<void> {
    const id = parseId(idValue, 'deployment');
    const known = await this.#find(id);
    await this.#store.transaction(async (session) => {
      const deployment = await this.#locked(session, known);
      assertMayDeploy(actor, deployment.environmentKind);
      check(deployment);
      authorize({ name: deployment.environmentName, kind: deployment.environmentKind }, action, request);
      if (await session.hasOpenCommand(id, action)) {
        return;
      }
      await session.addCommand(id, deployment.environmentId, action);
      await session.record([
        (action === 'promote' ? DeploymentPromoted : DeploymentAbortRequested).create({
          companyId: currentCompanyId(),
          actorId: actor.userId,
          payload: { deploymentId: id, applicationId: deployment.applicationId, environmentName: deployment.environmentName },
        }),
      ]);
    });
  }

  /**
   * Takes an agent's report: moves its environment's rollouts along, and hands back the
   * commands waiting for it. Called with each heartbeat.
   *
   * What other modules know of the rollouts and commands is read first. Then one short
   * transaction locks the rollouts, reads them again, and moves them along, so no
   * connection is held while other modules are asked.
   */
  #onReport(
    companyId: CompanyId,
    environmentId: string,
    report: { sync?: unknown; workloads?: unknown },
  ): Promise<AgentCommand[]> {
    const sync = parseSync(report.sync);
    const workloads = parseWorkloads(report.workloads);
    return runWithCompany(companyId, async () => {
      const { rows, pending } = await this.#store.transaction(async (session) => ({
        rows: await session.inEnvironment(environmentId, ROLLING_OUT),
        pending: await session.applicationsWithPendingCommands(environmentId),
      }));
      const known = await this.#enrich(rows);
      // Each application runs in a namespace named after it, as its rollout is.
      const slugs = new Map(known.map((deployment) => [deployment.applicationId, deployment.applicationSlug]));
      for (const [id, application] of await this.#applicationsById(pending.filter((id) => !slugs.has(id)))) {
        slugs.set(id, application.slug);
      }

      return this.#store.transaction(async (session) => {
        // Which application each reported workload belongs to, for stops, which have none of their own.
        const running = new Set(await session.applicationsOf(workloads.map((workload) => workload.deploymentId)));
        // Locked one by one in the same order every time, so two reports can't deadlock.
        for (const before of known) {
          const deployment = await this.#locked(session, before);
          if (!ROLLING_OUT.includes(deployment.status)) {
            // It changed since it was read, such as by an abort or the stall sweep.
            continue;
          }
          const next =
            deployment.action === 'stop'
              ? advanceStop(deployment, running.has(deployment.applicationId), sync)
              : advance(
                  { status: deployment.status, commitSha: deployment.commitSha },
                  workloads.find((workload) => workload.deploymentId === deployment.id),
                  sync,
                );
          const progressChanged = JSON.stringify(next.progress) !== JSON.stringify(deployment.progress);
          if (next.status === deployment.status && !progressChanged && next.message === deployment.message) {
            continue;
          }
          const finished = ['succeeded', 'failed', 'aborted'].includes(next.status);
          await session.updateRollout(deployment.id, { status: next.status, progress: next.progress, message: next.message, finished });
          if (finished) {
            await session.record([finishedEvent(deployment, next.status, next.message)]);
          }
          // Only the newest version that ran well is running; the earlier ones are replaced.
          if (next.status === 'succeeded') {
            await session.supersedeOthers(deployment);
          }
          // A rollback goes back to a version that ran well, so traffic switches as soon as it's up.
          if (next.status === 'paused' && deployment.rollbackOf !== null) {
            await session.addPromoteOnce(deployment.id, environmentId);
          }
        }
        // Only commands whose application was read above are sent. One made meanwhile waits for the next heartbeat.
        const commands = await session.sendPendingCommands(environmentId, [...slugs.keys()]);
        return commands.map((command) => {
          const slug = slugs.get(command.applicationId)!;
          return { id: command.id, action: command.action, namespace: slug, name: slug };
        });
      });
    });
  }

  /** The agent says how a command went. */
  async #commandDone(companyId: CompanyId, environmentId: string, commandValue: unknown, result: { succeeded?: unknown; message?: unknown }): Promise<void> {
    const id = parseId(commandValue, 'command');
    const outcome = {
      succeeded: result.succeeded === true,
      message: typeof result.message === 'string' ? result.message.slice(0, 1000) : null,
    };
    await runWithCompany(companyId, () => this.#store.transaction((session) => session.completeCommand(id, environmentId, outcome)));
  }

  /** Fails deployments that stopped moving, in every company. */
  async failStalled(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - STALL_MINUTES * 60_000);
    const stalled = await runWithCompany(NO_COMPANY, () => this.#store.transaction((session) => session.stalled(cutoff)));
    for (const { deploymentId: id, companyId: company } of stalled) {
      await runWithCompany(parseCompanyId(company), async () => {
        const known = await this.#find(id);
        await this.#store.transaction(async (session) => {
          const deployment = await this.#locked(session, known);
          if (!['queued', 'committed', 'progressing'].includes(deployment.status) || deployment.updatedAt >= cutoff) {
            return;
          }
          const message =
            deployment.status === 'queued'
              ? "The change couldn't be written to the environment's repository."
              : `The target didn't finish the rollout in ${STALL_MINUTES} minutes.`;
          await session.fail(id, message);
          await session.record([finishedEvent(deployment, 'failed', message)]);
        });
      });
    }
  }

  /**
   * Runs a deployment on This machine: checks the image's signature, pulls it by digest,
   * starts it with the environment's values, and waits until it's healthy. If it isn't,
   * the version before it runs again.
   */
  async #runLocal(deployment: KnownDeployment, environment: EnvironmentView): Promise<void> {
    const target: HostTarget = { id: environment.target!.id, settings: environment.target!.settings };
    // Unique on the machine: environments of other companies may share a short name.
    const name = containerName(deployment.applicationSlug, environment);
    const network = `${name}-net`;
    const step = (message: string, progress: Progress = { applied: false }) =>
      this.#store.transaction((session) => session.markProgressing(deployment.id, progress, message));
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
      const signature = await this.#builds.checkSignature(deployment.buildId);
      const unsigned = signature.checks.find((check) => check.outcome === 'failed');
      if (unsigned !== undefined) {
        await this.#finishLocal(deployment, 'failed', `${unsigned.name}: ${unsigned.detail ?? 'no'}. Nothing was pulled.`, null);
        return;
      }
      // By digest, so what runs is exactly what was built, scanned and signed.
      const image = `${deployment.imageRef!.replace(/:[^/:]+$/, '')}@${deployment.digest}`;
      await step('Pulling the image.');
      await this.#runtime.pull(target, image);
      const runtime = await this.#runtimeOf(deployment.applicationId);
      const settings = {
        runtime,
        config: await this.#valuesOf(deployment),
        configHash: await this.#config.fingerprint(deployment.environmentId, deployment.applicationId),
        preferredPort: await this.#store.transaction((session) => session.lastPort(deployment.environmentId, deployment.applicationId)),
      };
      const secrets = await this.#config.openSecrets(deployment.environmentId, deployment.applicationSlug);
      await step('Starting the new version.');
      const started = await this.#runtime.start(target, {
        name,
        network,
        image,
        labels: {
          'dreamdevops.company': currentCompanyId(),
          'dreamdevops.application': deployment.applicationSlug,
          'dreamdevops.environment': environment.slug,
          'dreamdevops.deployment': deployment.id,
          'dreamdevops.version': deployment.buildVersion ?? deployment.imageTag,
        },
        environment: {
          // On This machine, applications send straight to the platform's collector.
          ...withTelemetry(settings.config.variables, {
            environmentId: deployment.environmentId,
            applicationId: deployment.applicationId,
            serviceName: deployment.applicationSlug,
            metricsEndpoint: this.#options.localOtlpEndpoint === null ? null : `${this.#options.localOtlpEndpoint}/v1/metrics`,
            tracesEndpoint: this.#options.localOtlpEndpoint === null ? null : `${this.#options.localOtlpEndpoint}/v1/traces`,
          }),
          ...secrets,
          PORT: String(settings.runtime.port),
          ...platformVariables({ slug: environment.slug, production: environment.kind === 'production' }, deployment.buildVersion ?? deployment.imageTag),
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
    deployment: KnownDeployment,
    status: 'succeeded' | 'failed',
    message: string,
    recorded: { limits: ResourceLimits; configHash: string } | null,
    progress: Progress = { applied: status === 'succeeded' },
  ): Promise<void> {
    await this.#store.transaction(async (session) => {
      const finished = await session.finishRun(deployment.id, {
        status,
        message: message.slice(0, 1000),
        progress,
        limits: recorded?.limits ?? null,
        configHash: recorded?.configHash ?? null,
      });
      if (!finished) {
        return;
      }
      await session.record([finishedEvent(deployment, status, status === 'succeeded' ? null : message)]);
      if (status === 'succeeded') {
        await session.supersedeOthers(deployment);
      }
    });
  }

  /** The settings of the blueprint version an application started from, such as its port. */
  async #runtimeOf(applicationId: string): Promise<Runtime> {
    const source = (await this.#sources.find(applicationId))?.blueprint ?? null;
    const blueprint = source === null ? null : this.#blueprints.manifest(source.key, source.version);
    return blueprint === null ? DEFAULT_RUNTIME : blueprint.runtime;
  }

  /** The values a deployment's application gets in its environment, as Environments keeps them now. */
  #valuesOf(deployment: KnownDeployment): Promise<ResolvedConfig> {
    return this.#config.resolve(deployment.environmentId, { id: deployment.applicationId, slug: deployment.applicationSlug });
  }

  /**
   * Files for a deployment's version, with the environment's values as they are now. What
   * other contexts know, the environment, the runtime and the values, is asked for first.
   */
  #render(
    deployment: KnownDeployment,
    environment: Pick<EnvironmentView, 'slug' | 'kind'>,
    runtime: Runtime,
    config: ResolvedConfig,
  ): { files: Map<string, string>; limits: ResourceLimits } {
    // Images are named as targets pull them, and by digest.
    const path = deployment.imageRef!.replace(/^[^/]+\//, '').replace(/:[^/:]+$/, '');
    const files = renderApplication({
      deploymentId: deployment.id,
      application: { slug: deployment.applicationSlug, name: deployment.applicationName },
      environment: { slug: environment.slug, kind: environment.kind },
      image: `${this.#options.targetRegistryHost}/${path}@${deployment.digest}`,
      version: deployment.buildVersion ?? deployment.imageTag,
      strategy: deployment.strategy,
      runtime,
      // The standard OpenTelemetry settings, so the application's metrics and traces reach the platform.
      variables: withTelemetry(config.variables, {
        environmentId: deployment.environmentId,
        applicationId: deployment.applicationId,
        serviceName: deployment.applicationSlug,
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
    repository: EnvironmentRepository,
    deployment: KnownDeployment,
    files: Map<string, string>,
    message: string,
  ): Promise<string> {
    const folder = applicationFolder(deployment.applicationSlug);
    const existing = await this.#gitOps.readFolder(repository, folder);
    // The applications the environment runs are the root's list, as it is in the repository.
    const root = (await this.#gitOps.readFolder(repository, ROOT_FILE)).get(ROOT_FILE);
    const others = rootApplications(root).filter((slug) => slug !== deployment.applicationSlug);
    const changes: FileChange[] = [
      ...[...existing.keys()].filter((path) => !files.has(path)).map((path) => ({ path, content: null })),
      ...[...files].map(([path, content]) => ({ path, content })),
      { path: ROOT_FILE, content: renderRoot(files.size > 0 ? [...others, deployment.applicationSlug] : others) },
    ];
    return this.#gitOps.commit(repository, message, changes);
  }

  /**
   * A deployment, with what other modules know of it. Its row is read in a transaction of
   * its own, and the other modules are asked once that has ended. A transaction never waits
   * on them: each of them takes a database connection too, and with many requests at once,
   * connections held while waiting for more could use up the pool and stall everything.
   */
  async #find(id: string): Promise<KnownDeployment> {
    const deployment = await this.#store.transaction((session) => session.find(id));
    if (deployment === null) {
      throw new DeploymentError('not-found', 'This deployment does not exist.');
    }
    return (await this.#enrich([deployment]))[0]!;
  }

  /**
   * Locks a deployment's row and reads it again, keeping what other modules said of it
   * before. Their part, such as names, doesn't change what this module decides.
   */
  async #locked(session: DeploymentsSession, known: KnownDeployment): Promise<KnownDeployment> {
    const deployment = await session.find(known.id, { lock: true });
    if (deployment === null) {
      throw new DeploymentError('not-found', 'This deployment does not exist.');
    }
    return { ...known, ...deployment };
  }

  /**
   * Adds what the catalog, environments and builds know of each deployment. They keep
   * their own tables, so this asks them, once per application, environment and version.
   */
  async #enrich(rows: readonly StoredDeployment[]): Promise<KnownDeployment[]> {
    if (rows.length === 0) {
      return [];
    }
    const unique = (pick: (row: StoredDeployment) => string) => [...new Set(rows.map(pick))];
    const [applications, environments, builds] = await Promise.all([
      this.#applicationsById(unique((row) => row.applicationId)),
      Promise.all(unique((row) => row.environmentId).map((id) => this.#environments.get(id))).then(
        (views) => new Map<string, EnvironmentView>(views.map((view) => [view.id, view])),
      ),
      this.#builds.many(unique((row) => row.buildId)),
    ]);
    return rows.map((row) => {
      const application = applications.get(row.applicationId)!;
      const environment = environments.get(row.environmentId)!;
      const build: DeployableImage = builds.get(row.buildId)!;
      return {
        ...row,
        applicationName: application.name,
        applicationSlug: application.slug,
        environmentName: environment.name,
        environmentKind: environment.kind,
        environmentProvider: environment.target?.provider ?? null,
        buildKind: build.kind,
        imageTag: build.tag,
        buildVersion: build.version,
        imageRef: build.imageRef,
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
export type Confirmed = Unchecked<ProductionConfirmation>;

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
  return DeploymentQueued.create({ companyId: currentCompanyId(), actorId, payload: { deploymentId } });
}

function finishedEvent(deployment: KnownDeployment, status: DeploymentStatus, message: string | null) {
  const contract = status === 'succeeded' ? DeploymentSucceeded : status === 'aborted' ? DeploymentAborted : DeploymentFailed;
  return contract.create({
    companyId: currentCompanyId(),
    actorId: null,
    payload: {
      deploymentId: deployment.id,
      applicationId: deployment.applicationId,
      applicationName: deployment.applicationName,
      environmentId: deployment.environmentId,
      environmentName: deployment.environmentName,
      version: deployment.buildVersion ?? deployment.imageTag,
      action: deployment.action,
      ...(message !== null && status !== 'succeeded' && { reason: message }),
    },
  });
}

/** A list's filter, from the query's application and environment IDs. */
function parseFilter(filter: { application?: unknown; environment?: unknown }): DeploymentFilter {
  return {
    ...(filter.application !== undefined && filter.application !== '' && { applicationId: parseId(filter.application, 'application') }),
    ...(filter.environment !== undefined && filter.environment !== '' && { environmentId: parseId(filter.environment, 'environment') }),
  };
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

function toView(row: KnownDeployment): DeploymentView {
  return {
    id: row.id,
    application: { id: row.applicationId, name: row.applicationName, slug: row.applicationSlug },
    environment: { id: row.environmentId, name: row.environmentName, kind: row.environmentKind },
    version: { buildId: row.buildId, kind: row.buildKind, tag: row.imageTag, version: row.buildVersion },
    strategy: row.strategy,
    status: row.status,
    message: row.message,
    progress: row.progress,
    rollbackOf: row.rollbackOf,
    commit: row.commitSha,
    requestedBy: row.requestedBy === null ? null : { userId: row.requestedBy, displayName: row.requesterName },
    approvedBy: row.approvedBy === null ? null : { userId: row.approvedBy, displayName: row.approverName },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    action: row.action,
    reason: row.reason,
    limits: row.limits,
  };
}
