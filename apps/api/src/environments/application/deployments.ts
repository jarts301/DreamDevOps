import { TenantDatabase, type TenantTransaction } from '@dreamdevops/shared-kernel/postgres';
import type { DeployableImage, DeployableImages } from '../../builds/application/deployable-images.ts';
import type { ApplicationCatalog } from '../../catalog/application/application-catalog.ts';
import { hasPermissions, type Principal } from '../../identity-access/domain/access.ts';
import { normalizeName } from '../../shared/names.ts';
import { assertDeploymentConfirmed, deploymentKind, imageProblem } from '../domain/deployment.ts';
import { EnvironmentError } from '../domain/errors.ts';
import { findProvider } from '../domain/hosting-providers.ts';
import { authorizeChange, MAX_REASON_LENGTH } from '../domain/protection.ts';
import {
  type DeploymentRow,
  type DeploymentView,
  findDeployment,
  insertDeployment,
  parseDeploymentId,
  SELECT_DEPLOYMENTS,
  toDeploymentView,
} from './deployment-records.ts';
import {
  DEPLOY_TO_PRODUCTION,
  DEPLOY_TO_TEST,
  type EnvironmentRow,
  findEnvironment,
  lockEnvironment,
  parseEnvironmentId,
} from './environments.ts';
import type { HostRuntimes } from './ports.ts';

const HISTORY_LIMIT = 30;

/** A version that could be deployed to an environment, and whether it may be. */
export interface DeployOption {
  readonly buildId: string;
  readonly version: string;
  readonly kind: string;
  readonly productive: boolean;
  readonly builtAt: string;
  /** Why it can't be deployed here, such as a candidate for production, or null. */
  readonly problem: string | null;
  /** Whether it's what runs there now. */
  readonly live: boolean;
}

/**
 * Deploys versions of an application to its environments, and stops them. The work
 * itself runs in the background, in the DeploymentPipeline, and people follow its steps.
 *
 * Production runs only releases. Deploying to it needs the permission to deploy to
 * production and its name typed exactly. Stopping it also needs a reason.
 */
export class Deployments {
  readonly #database: TenantDatabase;
  readonly #catalog: ApplicationCatalog;
  readonly #images: DeployableImages;
  readonly #runtimes: HostRuntimes;

  constructor(database: TenantDatabase, catalog: ApplicationCatalog, images: DeployableImages, runtimes: HostRuntimes) {
    this.#database = database;
    this.#catalog = catalog;
    this.#images = images;
    this.#runtimes = runtimes;
  }

  /** The application's versions that built, newest first, and whether each may run in the environment. */
  async options(environmentId: unknown): Promise<DeployOption[]> {
    const environment = await this.#environment(environmentId);
    const images = await this.#images.list(environment.application_id);
    return images.map((image) => ({
      buildId: image.buildId,
      version: image.version,
      kind: image.kind,
      productive: image.productive,
      builtAt: image.builtAt,
      problem: imageProblem(environment, image),
      live: environment.live_deployment_id !== null && environment.live_build_id === image.buildId,
    }));
  }

  /** The environment's deployments, newest first, with each one's steps. */
  async list(environmentId: unknown): Promise<DeploymentView[]> {
    const environment = await this.#environment(environmentId);
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<DeploymentRow>(
        `${SELECT_DEPLOYMENTS} WHERE d.environment_id = $1 ORDER BY d.number DESC LIMIT ${HISTORY_LIMIT}`,
        [environment.id],
      );
      return rows.map(toDeploymentView);
    });
  }

  async get(deploymentId: unknown): Promise<DeploymentView> {
    const id = parseDeploymentId(deploymentId);
    return this.#database.transaction(async (tx) => {
      const row = await findDeployment(tx, id);
      if (row === null) {
        throw new EnvironmentError('not-found', 'This deployment does not exist.');
      }
      return toDeploymentView(row);
    });
  }

  /**
   * Deploys one of the application's images to the environment, on its hosting target. If
   * what runs now is on another target, such as after a move that failed, this moves it.
   */
  async deploy(
    actor: Principal,
    environmentId: unknown,
    input: { buildId?: unknown; confirmation?: unknown; reason?: unknown },
  ): Promise<DeploymentView> {
    const id = parseEnvironmentId(environmentId);
    const reason = optionalReason(input.reason);
    if (typeof input.buildId !== 'string') {
      throw new EnvironmentError('invalid', 'Choose the version to deploy.');
    }
    const image = await this.#images.find(input.buildId);
    return this.#database.transaction(async (tx) => {
      const environment = await lockEnvironment(tx, id);
      this.#assertMayDeploy(actor, environment);
      if (image === null || image.applicationId !== environment.application_id) {
        throw new EnvironmentError('invalid', "Choose one of this application's versions that built, published and signed.");
      }
      const problem = imageProblem(environment, image);
      if (problem !== null) {
        throw new EnvironmentError('conflict', problem);
      }
      assertDeploymentConfirmed(environment, input.confirmation);
      const target = await this.#deployableTarget(tx, environment);
      const kind = deploymentKind(environment.live_deployment_id === null ? null : environment.live_target_id, target.id);
      const deploymentId = await insertDeployment(tx, {
        environment,
        applicationName: (await this.#catalog.get(environment.application_id)).name,
        kind,
        image: toDeploy(image),
        version: image.version,
        target,
        previousTargetId: kind === 'move' ? environment.live_target_id : null,
        actor,
        reason,
      });
      return toDeploymentView((await findDeployment(tx, deploymentId))!);
    });
  }

  /**
   * Stops what runs in the environment and removes it from its host. Production also
   * needs its name typed exactly and a reason, as any change to it does.
   */
  async stop(actor: Principal, environmentId: unknown, input: { confirmation?: unknown; reason?: unknown }): Promise<DeploymentView> {
    const id = parseEnvironmentId(environmentId);
    return this.#database.transaction(async (tx) => {
      const environment = await lockEnvironment(tx, id);
      this.#assertMayDeploy(actor, environment);
      if (environment.live_deployment_id === null) {
        throw new EnvironmentError('conflict', `Nothing runs in ${environment.name}.`);
      }
      const reason = authorizeChange(environment, 'stop', {
        // Deploying to production is what allows stopping it.
        canManageProduction: true,
        confirmation: input.confirmation,
        reason: input.reason,
      });
      const { rows } = await tx.query<{ id: string; name: string; provider: string; status: string }>(
        'SELECT id, name, provider, status FROM environments.targets WHERE id = $1',
        [environment.live_target_id],
      );
      const target = rows[0]!;
      const deploymentId = await insertDeployment(tx, {
        environment,
        applicationName: (await this.#catalog.get(environment.application_id)).name,
        kind: 'stop',
        image: null,
        version: environment.live_version,
        target,
        previousTargetId: null,
        actor,
        reason,
      });
      return toDeploymentView((await findDeployment(tx, deploymentId))!);
    });
  }

  /** Anyone who deploys may deploy to environments that aren't production. Production needs more. */
  #assertMayDeploy(actor: Principal, environment: EnvironmentRow): void {
    if (environment.status === 'archived') {
      throw new EnvironmentError('conflict', 'Restore the environment first.');
    }
    if (!hasPermissions(actor, [environment.production ? DEPLOY_TO_PRODUCTION : DEPLOY_TO_TEST])) {
      throw new EnvironmentError(
        'forbidden',
        environment.production
          ? 'Only people who deploy to production can do this.'
          : 'Only people who deploy to test environments can do this.',
      );
    }
  }

  /** The environment's target, which must be active and one the platform can deploy to. */
  async #deployableTarget(
    tx: TenantTransaction,
    environment: EnvironmentRow,
  ): Promise<{ id: string; name: string; provider: string }> {
    if (environment.target_id === null) {
      throw new EnvironmentError('conflict', `Choose where ${environment.name} runs first.`);
    }
    const { rows } = await tx.query<{ id: string; name: string; provider: string; status: string }>(
      'SELECT id, name, provider, status FROM environments.targets WHERE id = $1 FOR SHARE',
      [environment.target_id],
    );
    const target = rows[0]!;
    if (target.status !== 'active') {
      throw new EnvironmentError('conflict', `Its hosting target, ${target.name}, is archived. Restore it, or choose another.`);
    }
    const problem = this.#runtimes.problem({ key: target.provider, name: findProvider(target.provider)?.name ?? target.provider });
    if (problem !== null) {
      throw new EnvironmentError('conflict', problem);
    }
    return target;
  }

  async #environment(environmentId: unknown): Promise<EnvironmentRow> {
    const id = parseEnvironmentId(environmentId);
    const environment = await this.#database.transaction((tx) => findEnvironment(tx, id));
    if (environment === null) {
      throw new EnvironmentError('not-found', 'This environment does not exist.');
    }
    return environment;
  }
}

function toDeploy(image: DeployableImage) {
  return {
    buildId: image.buildId,
    version: image.version,
    kind: image.kind,
    productive: image.productive,
    repository: image.repository,
    digest: image.digest,
  };
}

function optionalReason(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const reason = normalizeName(value, { minLength: 1, maxLength: MAX_REASON_LENGTH, refuseControlCharacters: true });
  if (reason === null) {
    throw new EnvironmentError('invalid', `Keep the reason under ${MAX_REASON_LENGTH} characters.`);
  }
  return reason;
}
