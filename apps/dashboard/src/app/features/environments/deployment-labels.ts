import type { Tone } from '../../shared/steps';
import type { Deployment, DeploymentKind, DeploymentStatus, ImageKind } from './environments.api';

const IMAGE_KIND_NAMES: Readonly<Record<ImageKind, string>> = {
  development: 'Development',
  'release-candidate': 'Release candidate',
  'hotfix-candidate': 'Hotfix candidate',
  release: 'Release',
};

const STATUS_NAMES: Readonly<Record<DeploymentStatus, string>> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
};

const KIND_NAMES: Readonly<Record<DeploymentKind, string>> = { deploy: 'Deploy', move: 'Move', stop: 'Stop' };

export const imageKindName = (kind: ImageKind | null): string => (kind === null ? 'Image' : (IMAGE_KIND_NAMES[kind] ?? kind));
export const deploymentStatusName = (status: DeploymentStatus): string => STATUS_NAMES[status] ?? status;
export const deploymentKindName = (kind: DeploymentKind): string => KIND_NAMES[kind] ?? kind;
export const isUnderWay = (status: DeploymentStatus): boolean => status === 'queued' || status === 'running';

export function deploymentTone(status: DeploymentStatus): Tone {
  return status === 'succeeded' ? 'success' : status === 'failed' ? 'danger' : 'progress';
}

/** One line about a deployment, such as "Deploy 1.5.0 to This machine" or "Move 1.5.0 from This machine to Office server". */
export function describeDeployment(deployment: Deployment): string {
  const version = deployment.version ?? 'what runs';
  switch (deployment.kind) {
    case 'move':
      return `Move ${version} from ${deployment.previousTarget?.name ?? 'the previous target'} to ${deployment.target.name}`;
    case 'stop':
      return `Stop ${version} on ${deployment.target.name}`;
    default:
      return `Deploy ${version} to ${deployment.target.name}`;
  }
}
