import { pendingSteps, type StepRecord } from '../../shared/progress.ts';
import { EnvironmentError } from './errors.ts';

/**
 * What a deployment does. Deploy runs a version on the environment's hosting target.
 * Move does the same on a new target, then removes the version from the old one. Stop
 * removes what runs, leaving the environment empty.
 */
export type DeploymentKind = 'deploy' | 'move' | 'stop';

export type DeploymentStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/** The steps a deployment goes through. Their keys are stored, so they must never change. */
export type DeploymentStepKey = 'validate' | 'verify' | 'pull' | 'start' | 'health' | 'retire' | 'stop';

export type DeploymentStep = StepRecord<DeploymentStepKey>;

export const DEPLOYMENT_STEP_NAMES: Readonly<Record<DeploymentStepKey, string>> = {
  validate: 'Check the version and environment',
  verify: 'Verify the signature',
  pull: 'Pull the image',
  start: 'Start the new version',
  health: 'Wait until it’s healthy',
  retire: 'Remove it from the previous host',
  stop: 'Stop and remove it',
};

const RUN_STEPS: readonly DeploymentStepKey[] = ['validate', 'verify', 'pull', 'start', 'health'];

export function deploymentSteps(kind: DeploymentKind): readonly DeploymentStepKey[] {
  switch (kind) {
    case 'deploy':
      return RUN_STEPS;
    case 'move':
      return [...RUN_STEPS, 'retire'];
    case 'stop':
      return ['validate', 'stop'];
  }
}

export function initialDeploymentSteps(kind: DeploymentKind): DeploymentStep[] {
  return pendingSteps(deploymentSteps(kind));
}

/** What decides whether an image may run in an environment. */
export interface ImageToRun {
  readonly version: string;
  /** The kind of build, such as release or release-candidate. */
  readonly kind: string;
  /** Only releases are productive. */
  readonly productive: boolean;
}

const IMAGE_KIND_NAMES: Readonly<Record<string, string>> = {
  development: 'a development image',
  'release-candidate': 'a release candidate',
  'hotfix-candidate': 'a hotfix candidate',
  release: 'a release',
};

export function imageKindName(kind: string): string {
  return IMAGE_KIND_NAMES[kind] ?? 'an image';
}

/**
 * Why an image can't run in an environment, or null if it can. Production runs only
 * productive images, which are releases: candidates and development images are for
 * trying out elsewhere.
 */
export function imageProblem(environment: { readonly name: string; readonly production: boolean }, image: ImageToRun): string | null {
  if (environment.production && !image.productive) {
    return `${environment.name} is a production environment, so it runs only releases. ${image.version} is ${imageKindName(image.kind)}.`;
  }
  return null;
}

/**
 * Refuses to make an environment production while it runs, or is about to run, an image
 * production mustn't. Otherwise marking it would put a candidate into production.
 */
export function assertMayBecomeProduction(
  environment: { readonly name: string },
  live: ImageToRun | null,
  deploying: boolean,
): void {
  if (deploying) {
    throw new EnvironmentError('conflict', `Wait for the deployment to ${environment.name} to finish first.`);
  }
  if (live !== null && !live.productive) {
    throw new EnvironmentError(
      'conflict',
      `${environment.name} runs ${live.version}, which is ${imageKindName(live.kind)}. Production runs only releases, so deploy a release to it, or stop it, first.`,
    );
  }
}

/**
 * Deploying to production needs its name typed exactly, so a slip can't replace what
 * production runs. A reason is optional, and kept in the audit log.
 */
export function assertDeploymentConfirmed(
  environment: { readonly name: string; readonly production: boolean },
  confirmation: unknown,
): void {
  if (environment.production && confirmation !== environment.name) {
    throw new EnvironmentError('invalid', `This deploys to production. To confirm, type its name exactly: ${environment.name}`);
  }
}

/**
 * A deployment moves what runs when the version that runs now is on another target than
 * the environment's, such as after someone switched its target.
 */
export function deploymentKind(liveTargetId: string | null, targetId: string): 'deploy' | 'move' {
  return liveTargetId !== null && liveTargetId !== targetId ? 'move' : 'deploy';
}

const NAME_PART = /[^a-z0-9-]+/g;

/**
 * The name of an environment's container on its host. Hosts are shared by every company,
 * so it ends with part of the environment's ID, which makes it unique, and it starts with
 * names people recognize.
 */
export function containerName(applicationSlug: string, environmentSlug: string, environmentId: string): string {
  const part = (value: string, length: number) => value.toLowerCase().replace(NAME_PART, '-').slice(0, length).replace(/^-+|-+$/g, '');
  return ['dreamdevops', part(applicationSlug, 24), part(environmentSlug, 20), environmentId.replaceAll('-', '').slice(0, 12)]
    .filter((piece) => piece !== '')
    .join('-');
}

/** Each environment gets its own network, so it can't reach other companies' or environments' containers. */
export function networkName(environmentId: string): string {
  return `dreamdevops-env-${environmentId.replaceAll('-', '')}`;
}

/** What a container may use at most, in words, such as "1 CPU and 512 MiB of memory". */
export function describeLimits(limits: { readonly cpus: number; readonly memoryBytes: number } | null): string {
  if (limits === null) {
    return 'None';
  }
  const cpus = `${Number(limits.cpus.toFixed(2))} ${limits.cpus === 1 ? 'CPU' : 'CPUs'}`;
  const mebibytes = limits.memoryBytes / (1024 * 1024);
  const memory = mebibytes >= 1024 ? `${Number((mebibytes / 1024).toFixed(2))} GiB` : `${Number(mebibytes.toFixed(1))} MiB`;
  return `${cpus} and ${memory} of memory`;
}
