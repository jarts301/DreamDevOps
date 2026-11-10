import type { Tone } from '../../shared/steps';
import type { BuildKind, BuildStatus } from './builds.api';

export { duration, stepStatusName, stepSymbol, stepTone, type Tone } from '../../shared/steps';

const KIND_NAMES: Readonly<Record<BuildKind, string>> = {
  development: 'Development',
  'release-candidate': 'Release candidate',
  'hotfix-candidate': 'Hotfix candidate',
  release: 'Release',
};

const BUILD_STATUS_NAMES: Readonly<Record<BuildStatus, string>> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
};

export const kindName = (kind: BuildKind): string => KIND_NAMES[kind] ?? kind;
export const buildStatusName = (status: BuildStatus): string => BUILD_STATUS_NAMES[status] ?? status;

export const isActive = (status: BuildStatus): boolean => status === 'queued' || status === 'running';

export function buildTone(status: BuildStatus): Tone {
  return status === 'succeeded' ? 'success' : status === 'failed' ? 'danger' : 'progress';
}
