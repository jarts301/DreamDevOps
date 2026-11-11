import { createDomainEvent, currentCompanyId, describeError } from '@dreamdevops/shared-kernel';
import { appendToOutbox, TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type pg from 'pg';
import type { DeployableImages } from '../../builds/application/deployable-images.ts';
import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import { type Check, failed, failures, finishStep, passed, type StepOutcome, warning } from '../../shared/progress.ts';
import {
  containerName,
  DEPLOYMENT_STEP_NAMES,
  type DeploymentStep,
  type DeploymentStepKey,
  imageKindName,
  imageProblem,
  initialDeploymentSteps,
  networkName,
} from '../domain/deployment.ts';
import type { DeploymentFailedPayload, DeploymentSucceededPayload } from '../domain/events.ts';
import { findProvider, type HostingSettings } from '../domain/hosting-providers.ts';
import { SecretUnreadableError } from '../domain/secret-box.ts';
import { withTelemetry } from '../domain/telemetry.ts';
import { platformVariables } from '../domain/variables.ts';
import { type DeploymentRow, findDeployment, imageReference, payloadOf } from './deployment-records.ts';
import type { EnvironmentVariables } from './environment-variables.ts';
import { type EnvironmentRow, findEnvironment } from './environments.ts';
import {
  type HostRuntime,
  type HostRuntimes,
  type HostTarget,
  PermanentDeploymentError,
  type StartedContainer,
} from './ports.ts';

/** The queue that runs deployments. Each job is one deployment. */
export const DEPLOY_QUEUE = 'environments.deploy';

export interface DeploymentJob {
  readonly companyId: string;
  readonly deploymentId: string;
}

export interface DeploymentPipelineOptions {
  /** Runs before a deployment that keeps hitting temporary problems is marked as failed. */
  readonly maxAttempts: number;
  /** How long a new version has to become healthy before it's rolled back. */
  readonly healthTimeoutMs: number;
  /** Where containers send their metrics, over OTLP, or null to tell them nowhere. */
  readonly metricsEndpoint: string | null;
}

interface TargetRow {
  id: string;
  name: string;
  provider: string;
  settings: HostingSettings;
  status: string;
}

/** What the steps of one deployment share. */
interface DeploymentContext {
  readonly deployment: DeploymentRow;
  readonly environment: EnvironmentRow;
  readonly applicationName: string;
  readonly target: TargetRow;
  readonly runtime: HostRuntime | null;
  readonly previousTarget: TargetRow | null;
  readonly container: string;
  readonly network: string;
  /** The image by digest, for everything but a stop. */
  readonly image: string | null;
  readonly labels: Readonly<Record<string, string>>;
  /** Set by the start step. */
  started: StartedContainer | null;
  /** The environment's settings revision the container started with. Set by the start step. */
  settingsRevision: number | null;
}

/** A check failed, or something else means trying again can't help. */
class StepFailed extends Error {
  readonly outcome: StepOutcome;

  constructor(summary: string, outcome: StepOutcome = {}) {
    super(summary);
    this.name = 'StepFailed';
    this.outcome = { ...outcome, summary };
  }
}

/**
 * Runs a deployment's steps in order: check the version and environment, verify the
 * image's signature, pull it, start it beside the version before it, and wait until it's
 * healthy. Only then is the version before it removed. If the new version doesn't become
 * healthy, it's removed and the version before it starts again.
 *
 * Progress is saved after every step, so people can follow it. A failed check stops the
 * deployment for good. Anything else is tried again from the start.
 */
export class DeploymentPipeline {
  readonly #database: TenantDatabase;
  readonly #pool: pg.Pool;
  readonly #catalog: ApplicationCatalog;
  readonly #images: DeployableImages;
  readonly #runtimes: HostRuntimes;
  readonly #variables: EnvironmentVariables;
  readonly #options: DeploymentPipelineOptions;
  readonly #steps: Readonly<Record<DeploymentStepKey, (context: DeploymentContext) => Promise<StepOutcome>>>;

  constructor(
    database: TenantDatabase,
    pool: pg.Pool,
    catalog: ApplicationCatalog,
    images: DeployableImages,
    runtimes: HostRuntimes,
    variables: EnvironmentVariables,
    options: DeploymentPipelineOptions,
  ) {
    this.#database = database;
    this.#pool = pool;
    this.#catalog = catalog;
    this.#images = images;
    this.#runtimes = runtimes;
    this.#variables = variables;
    this.#options = options;
    this.#steps = {
      validate: (context) => this.#validate(context),
      verify: (context) => this.#verify(context),
      pull: (context) => this.#pull(context),
      start: (context) => this.#start(context),
      health: (context) => this.#health(context),
      retire: (context) => this.#retire(context),
      stop: (context) => this.#stop(context),
    };
  }

  /**
   * Runs one deployment, in its company. Throws to have the job tried again later. Only
   * one worker runs a deployment at a time: the lock is held by a database session, so
   * it's released if the worker dies.
   */
  async run(deploymentId: string): Promise<void> {
    const client = await this.#pool.connect();
    const lockKey = `environments:deploy:${deploymentId}`;
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [lockKey],
      );
      if (!rows[0]?.locked) {
        return;
      }
      try {
        await this.#run(deploymentId);
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
      }
    } finally {
      client.release();
    }
  }

  async #run(deploymentId: string): Promise<void> {
    const context = await this.#load(deploymentId);
    if (context === null) {
      return;
    }
    const steps = initialDeploymentSteps(context.deployment.kind);
    const attempt = await this.#begin(deploymentId, steps);
    let current = 0;
    try {
      for (; current < steps.length; current += 1) {
        const key = steps[current]!.key;
        steps[current] = { ...steps[current]!, status: 'running', startedAt: new Date().toISOString() };
        await this.#saveSteps(deploymentId, steps);
        const outcome = await this.#steps[key](context);
        const failing = failures(outcome.checks ?? []);
        if (failing.length > 0) {
          throw new StepFailed(
            outcome.summary ?? (failing.length === 1 ? `Failed: ${failing[0]!.name}.` : `${failing.length} checks failed.`),
            outcome,
          );
        }
        steps[current] = finishStep(steps[current]!, outcome.skipped ? 'skipped' : 'passed', outcome);
        await this.#saveSteps(deploymentId, steps);
      }
      await this.#succeed(context, steps);
    } catch (error) {
      const permanent = error instanceof StepFailed || error instanceof PermanentDeploymentError;
      const final = permanent || attempt >= this.#options.maxAttempts;
      const reason = describeError(error);
      const rollback = await this.#rollBack(context);
      const base: StepOutcome =
        error instanceof StepFailed
          ? error.outcome
          : { summary: final ? reason : `${reason} Trying again (attempt ${attempt} of ${this.#options.maxAttempts}).` };
      const outcome = rollback === null ? base : { ...base, summary: `${base.summary ?? reason} ${rollback.summary}` };
      const step = steps[current];
      if (step !== undefined) {
        steps[current] = finishStep(step, 'failed', outcome);
      }
      await this.#fail(context, steps, step?.key ?? null, reason, final, rollback?.nothingRuns ?? false);
      if (!final) {
        throw error;
      }
    }
  }

  /** Everything a deployment needs, or null when it's done already. */
  async #load(deploymentId: string): Promise<DeploymentContext | null> {
    const loaded = await this.#database.transaction(async (tx) => {
      const deployment = await findDeployment(tx, deploymentId);
      if (deployment === null || deployment.status === 'succeeded' || deployment.status === 'failed') {
        return null;
      }
      const environment = (await findEnvironment(tx, deployment.environment_id))!;
      const { rows: targets } = await tx.query<TargetRow>(
        'SELECT id, name, provider, settings, status FROM environments.targets WHERE id = ANY($1)',
        [[deployment.target_id, deployment.previous_target_id].filter((id) => id !== null)],
      );
      return { deployment, environment, targets };
    });
    if (loaded === null) {
      return null;
    }
    const { deployment, environment, targets } = loaded;
    const application = await this.#catalog.get(deployment.application_id);
    const target = targets.find((row) => row.id === deployment.target_id)!;
    const image = imageReference(deployment);
    return {
      deployment,
      environment,
      applicationName: application.name,
      target,
      runtime: this.#runtimes.find(target.provider),
      previousTarget: targets.find((row) => row.id === deployment.previous_target_id) ?? null,
      container: containerName(application.slug, environment.slug, environment.id),
      network: networkName(environment.id),
      image,
      labels: {
        'dreamdevops.managed': 'true',
        'dreamdevops.company': currentCompanyId(),
        'dreamdevops.application': application.slug,
        'dreamdevops.environment': environment.slug,
        'dreamdevops.environment-id': environment.id,
        'dreamdevops.deployment': deployment.id,
        'org.opencontainers.image.version': deployment.version ?? '',
      },
      started: null,
      settingsRevision: null,
    };
  }

  /** Checks again, now that it runs, what was checked when it was asked for: things may have changed. */
  async #validate(context: DeploymentContext): Promise<StepOutcome> {
    const { deployment, environment, target } = context;
    const checks: Check[] = [
      environment.status === 'active'
        ? passed('The environment is active', environment.name)
        : failed('The environment is active', `${environment.name} was archived meanwhile.`),
    ];
    if (deployment.kind !== 'stop') {
      checks.push(
        environment.target_id === deployment.target_id
          ? passed('It still runs on this hosting target', target.name)
          : failed(
              'It still runs on this hosting target',
              `${environment.name} moved to ${environment.target_name ?? 'no target'} meanwhile. Deploy again to run it there.`,
            ),
      );
    }
    checks.push(
      target.status === 'active'
        ? passed('The hosting target is active', target.name)
        : failed('The hosting target is active', `${target.name} was archived meanwhile.`),
    );
    const providerName = findProvider(target.provider)?.name ?? target.provider;
    const problem = this.#runtimes.problem({ key: target.provider, name: providerName });
    checks.push(
      problem === null
        ? passed('The platform can deploy to this host', providerName)
        : failed('The platform can deploy to this host', problem),
    );
    if (deployment.kind === 'stop') {
      checks.push(
        passed(
          'Something runs here',
          environment.live_version === null
            ? 'Nothing runs, so this only cleans up.'
            : `${environment.live_version} on ${environment.live_target_name ?? target.name}`,
        ),
      );
      return { checks };
    }
    const image = await this.#images.find(deployment.build_id!);
    checks.push(
      image !== null && image.digest === deployment.digest
        ? passed('The image was built, published and signed', `${deployment.version}, ${imageKindName(deployment.image_kind ?? '')}`)
        : failed('The image was built, published and signed', 'Its build can no longer be found.'),
    );
    const productionProblem = imageProblem(environment, {
      version: deployment.version!,
      kind: deployment.image_kind ?? '',
      productive: deployment.productive,
    });
    checks.push(
      productionProblem === null
        ? passed(
            'Production runs only releases',
            environment.production
              ? `${deployment.version} is a release.`
              : `${environment.name} isn’t production, so any version that built may run.`,
          )
        : failed('Production runs only releases', productionProblem),
    );
    return { checks };
  }

  /** Checks the signature right before running, so only exactly what the platform built and signed ever runs. */
  async #verify(context: DeploymentContext): Promise<StepOutcome> {
    const { deployment } = context;
    const { valid, checks } = await this.#images.verify({ repository: deployment.repository!, digest: deployment.digest! });
    return {
      summary: valid
        ? 'The signature checks out, so this is exactly the image the platform built.'
        : 'The signature doesn’t check out, so the image won’t run.',
      checks,
      facts: [{ label: 'Image', value: context.image! }],
    };
  }

  async #pull(context: DeploymentContext): Promise<StepOutcome> {
    const pulled = await context.runtime!.pull(hostTarget(context.target), context.image!);
    return {
      summary: `Pulled ${context.deployment.version} onto ${context.target.name}.`,
      facts: [
        { label: 'Size', value: `${(pulled.sizeBytes / 1_000_000).toFixed(1)} MB` },
        { label: 'Ports', value: pulled.exposedPorts.length > 0 ? pulled.exposedPorts.join(', ') : 'None' },
      ],
    };
  }

  /**
   * Reads the environment's variables and opens its secrets now, as the container starts,
   * so it gets the settings as they are at this moment. Values stay in memory, and only
   * their names are reported.
   */
  async #start(context: DeploymentContext): Promise<StepOutcome> {
    const { deployment, environment } = context;
    let settings;
    try {
      settings = await this.#variables.resolve(environment.id);
    } catch (error) {
      if (error instanceof SecretUnreadableError) {
        return {
          summary: 'A secret can’t be read, so nothing was started.',
          checks: [failed('Its secrets can be read', error.message)],
        };
      }
      throw error;
    }
    context.settingsRevision = settings.revision;
    // The platform's own variables come last, so nothing replaces them.
    const variables = {
      ...withTelemetry(settings.values, environment.id, this.#options.metricsEndpoint),
      ...platformVariables(environment, deployment.version!),
    };
    // The environment keeps its port on the same host, so its address stays the same.
    const samePlace = environment.live_deployment_id !== null && environment.live_target_id === deployment.target_id;
    context.started = await context.runtime!.start(hostTarget(context.target), {
      name: context.container,
      network: context.network,
      image: context.image!,
      labels: context.labels,
      environment: variables,
      preferredPort: samePlace ? environment.live_port : null,
    });
    return {
      summary: context.started.replaced
        ? `Started ${deployment.version}. The version before it is kept, stopped, until this one is healthy.`
        : `Started ${deployment.version}.`,
      facts: [
        { label: 'Container', value: context.container },
        { label: 'Port', value: context.started.port === null ? 'None' : String(context.started.port) },
        { label: 'Variables', value: settings.variables.length === 0 ? 'None' : settings.variables.join(', ') },
        { label: 'Secrets', value: settings.secrets.length === 0 ? 'None' : settings.secrets.join(', ') },
      ],
    };
  }

  async #health(context: DeploymentContext): Promise<StepOutcome> {
    const target = hostTarget(context.target);
    const health = await context.runtime!.waitUntilHealthy(target, context.container, this.#options.healthTimeoutMs);
    if (!health.healthy) {
      return {
        summary: `${context.deployment.version} didn’t become healthy.`,
        checks: [failed('It became healthy', health.detail)],
      };
    }
    await context.runtime!.commit(target, context.container);
    const address = context.started?.address ?? null;
    return {
      summary: `${context.deployment.version} is healthy${address === null ? '' : ` at ${address}`}.`,
      checks: [passed('It became healthy', health.detail)],
      facts: address === null ? [] : [{ label: 'Address', value: address }],
    };
  }

  /** After a move, removes the version from the previous host. The move has worked by then, so a failure is only a warning. */
  async #retire(context: DeploymentContext): Promise<StepOutcome> {
    const previous = context.previousTarget!;
    const runtime = this.#runtimes.find(previous.provider);
    try {
      if (runtime === null) {
        throw new Error(`The platform can't reach ${previous.name} targets.`);
      }
      await runtime.remove(hostTarget(previous), context.container, context.network);
      return { summary: `Removed it from ${previous.name}.` };
    } catch (error) {
      return {
        summary: `It runs on ${context.target.name} now, but couldn’t be removed from ${previous.name}.`,
        checks: [
          warning(
            `It was removed from ${previous.name}`,
            `${describeError(error)} Remove the container ${context.container} there yourself.`,
          ),
        ],
      };
    }
  }

  async #stop(context: DeploymentContext): Promise<StepOutcome> {
    await context.runtime!.remove(hostTarget(context.target), context.container, context.network);
    const version = context.deployment.version;
    return { summary: `${version === null ? 'Everything' : version} stopped and removed from ${context.target.name}.` };
  }

  /**
   * After a failure, removes the new version and starts the one before it again. Returns
   * what to tell people, or null when nothing had started.
   */
  async #rollBack(context: DeploymentContext): Promise<{ summary: string; nothingRuns: boolean } | null> {
    if (context.started === null || context.runtime === null) {
      return null;
    }
    const restored = await context.runtime.rollBack(hostTarget(context.target), context.container).catch(() => false);
    context.started = null;
    if (context.deployment.kind === 'move') {
      return {
        summary: `Removed it from ${context.target.name}. ${context.environment.live_version ?? 'The version before it'} still runs on ${context.environment.live_target_name ?? 'the previous target'}.`,
        nothingRuns: false,
      };
    }
    return restored
      ? { summary: `Rolled back: ${context.environment.live_version ?? 'the version before it'} runs again.`, nothingRuns: false }
      : { summary: 'It was removed, and nothing runs in the environment now.', nothingRuns: true };
  }

  /** Marks the deployment as running, from the first step, and returns which attempt this is. */
  async #begin(deploymentId: string, steps: readonly DeploymentStep[]): Promise<number> {
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<{ attempts: number }>(
        `UPDATE environments.deployments
         SET status = 'running', attempts = attempts + 1, steps = $2, last_error = NULL,
             started_at = coalesce(started_at, now()), updated_at = now()
         WHERE id = $1
         RETURNING attempts`,
        [deploymentId, JSON.stringify(steps)],
      );
      return rows[0]!.attempts;
    });
  }

  async #saveSteps(deploymentId: string, steps: readonly DeploymentStep[]): Promise<void> {
    await this.#database.transaction((tx) =>
      tx.query('UPDATE environments.deployments SET steps = $2, updated_at = now() WHERE id = $1', [
        deploymentId,
        JSON.stringify(steps),
      ]),
    );
  }

  /** Records the result, and what runs in the environment now. */
  async #succeed(context: DeploymentContext, steps: readonly DeploymentStep[]): Promise<void> {
    const { deployment, environment } = context;
    const address = context.started?.address ?? null;
    await this.#database.transaction(async (tx) => {
      await tx.query(
        `UPDATE environments.deployments
         SET status = 'succeeded', steps = $2, host_port = $3, address = $4, settings_revision = $5,
             finished_at = now(), updated_at = now()
         WHERE id = $1`,
        [deployment.id, JSON.stringify(steps), context.started?.port ?? null, address, context.settingsRevision],
      );
      await tx.query('UPDATE environments.environments SET live_deployment_id = $2 WHERE id = $1', [
        environment.id,
        deployment.kind === 'stop' ? null : deployment.id,
      ]);
      await appendToOutbox(tx, [
        createDomainEvent<'DeploymentSucceeded', DeploymentSucceededPayload>({
          eventType: 'DeploymentSucceeded',
          companyId: currentCompanyId(),
          actorId: null,
          payload: { ...payloadOf(deployment, this.#names(context)), address },
        }),
      ]);
    });
  }

  async #fail(
    context: DeploymentContext,
    steps: readonly DeploymentStep[],
    step: DeploymentStepKey | null,
    reason: string,
    final: boolean,
    nothingRuns: boolean,
  ): Promise<void> {
    const { deployment, environment } = context;
    await this.#database.transaction(async (tx) => {
      await tx.query(
        `UPDATE environments.deployments
         SET status = $2, steps = $3, last_error = $4, finished_at = CASE WHEN $2 = 'failed' THEN now() END,
             updated_at = now()
         WHERE id = $1`,
        [deployment.id, final ? 'failed' : 'queued', JSON.stringify(steps), reason],
      );
      if (nothingRuns) {
        await tx.query('UPDATE environments.environments SET live_deployment_id = NULL WHERE id = $1', [environment.id]);
      }
      if (final) {
        const stillRunning = nothingRuns ? null : environment.live_version;
        await appendToOutbox(tx, [
          createDomainEvent<'DeploymentFailed', DeploymentFailedPayload>({
            eventType: 'DeploymentFailed',
            companyId: currentCompanyId(),
            actorId: null,
            payload: {
              ...payloadOf(deployment, this.#names(context)),
              step: step === null ? null : DEPLOYMENT_STEP_NAMES[step],
              error: reason,
              stillRunning: environment.live_deployment_id === null ? null : stillRunning,
            },
          }),
        ]);
      }
    });
  }

  #names(context: DeploymentContext) {
    return { environmentName: context.environment.name, applicationName: context.applicationName };
  }
}

function hostTarget(row: TargetRow): HostTarget {
  return { id: row.id, name: row.name, provider: row.provider, settings: row.settings };
}
