import { EnvironmentError } from './errors.ts';

/**
 * What may happen to an environment, or to what runs in it. Changes to production need
 * its name typed exactly, and most need a reason too.
 */
export type ProtectedChange =
  | 'create'
  | 'rename'
  | 'change-approval'
  | 'archive'
  | 'connect-target'
  | 'disconnect-target'
  | 'change-variables'
  | 'deploy'
  | 'approve'
  | 'promote'
  | 'abort'
  | 'rollback'
  | 'stop'
  | 'apply';

export interface ChangeRequest {
  /** Whether the person may manage production environments. */
  readonly canManageProduction: boolean;
  /** The environment's name, typed by the person to show they mean it. */
  readonly confirmation?: unknown;
  /** Why they're making the change, kept in the audit log. */
  readonly reason?: unknown;
}

export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 500;

/**
 * Changes to the environment itself, which need the permission to manage production.
 * Deploying, and production's values, have permissions of their own.
 */
const ENVIRONMENT_CHANGES: ReadonlySet<ProtectedChange> = new Set([
  'create',
  'rename',
  'change-approval',
  'archive',
  'connect-target',
  'disconnect-target',
]);
/** Running or steering a version that was asked for: a reason is optional. */
const RUNS: ReadonlySet<ProtectedChange> = new Set(['deploy', 'approve', 'promote', 'abort', 'apply']);
/** Changes that need no confirmation: adding production, or connecting where it will run. */
const SAFE: ReadonlySet<ProtectedChange> = new Set(['create', 'connect-target']);

/**
 * The rules that protect production from mistakes. Changing the production environment
 * itself needs the permission to manage it. Any change to production needs its name typed
 * exactly, so it can't happen by a slip, and a reason, except for running or steering a
 * version that was asked for, where one is optional.
 *
 * Returns the reason to record, or null when none was given.
 */
export function authorizeChange(
  environment: { readonly name: string; readonly production: boolean },
  change: ProtectedChange,
  request: ChangeRequest,
): string | null {
  const reason = optionalReason(request.reason);
  if (!environment.production) {
    return reason;
  }
  if (ENVIRONMENT_CHANGES.has(change) && !request.canManageProduction) {
    throw new EnvironmentError('forbidden', 'Only Tech Leads and Operators manage production environments.');
  }
  if (SAFE.has(change)) {
    return reason;
  }
  if (request.confirmation !== environment.name) {
    throw new EnvironmentError('invalid', `This affects production. To confirm, type its name exactly: ${environment.name}`);
  }
  if (reason === null && !RUNS.has(change)) {
    throw new EnvironmentError(
      'invalid',
      `Say why you're changing production, in ${MIN_REASON_LENGTH} to ${MAX_REASON_LENGTH} characters.`,
    );
  }
  return reason;
}

function optionalReason(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const reason = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  // eslint-disable-next-line no-control-regex
  if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new EnvironmentError('invalid', `Give a reason between ${MIN_REASON_LENGTH} and ${MAX_REASON_LENGTH} characters.`);
  }
  return reason;
}
