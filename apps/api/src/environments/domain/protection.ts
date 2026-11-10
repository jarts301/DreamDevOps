import { normalizeName } from '../../shared/names.ts';
import { EnvironmentError } from './errors.ts';

/** What may happen to an environment, or to a hosting target. */
export type ProtectedChange =
  | 'create'
  | 'rename'
  | 'switch-target'
  | 'protect'
  | 'unprotect'
  | 'archive'
  | 'edit-target'
  | 'stop'
  | 'change-variables';

export interface ChangeRequest {
  /** Whether the person may manage production environments. */
  readonly canManageProduction: boolean;
  /** The protected thing's name, typed by the person to show they mean it. */
  readonly confirmation?: unknown;
  /** Why they're making the change, kept in the audit log. */
  readonly reason?: unknown;
}

export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 500;

/**
 * The rules that protect production from mistakes. Anything that touches production
 * needs the permission to manage it. Changing or removing production also needs its
 * name typed exactly and a reason, so it can't happen by a slip, and archiving it
 * needs its protection removed first, which is itself such a change.
 *
 * Returns the reason to record, or null when none was given or needed.
 *
 * @param name The protected thing's name, such as "Production" or a target's name.
 * @param production Whether it's production now, or serves production for a target.
 */
export function authorizeChange(
  subject: { readonly name: string; readonly production: boolean },
  change: ProtectedChange,
  request: ChangeRequest,
): string | null {
  const reason = optionalReason(request.reason);
  // Adding protection, or creating production, is safe, but only for those who manage production.
  if (change === 'protect' || (change === 'create' && subject.production)) {
    assertMayManageProduction(request);
    return reason;
  }
  if (!subject.production) {
    return reason;
  }
  assertMayManageProduction(request);
  if (change === 'archive') {
    throw new EnvironmentError('conflict', 'Remove the production protection before archiving this environment.');
  }
  if (request.confirmation !== subject.name) {
    throw new EnvironmentError('invalid', `This affects production. To confirm, type its name exactly: ${subject.name}`);
  }
  if (reason === null) {
    throw new EnvironmentError(
      'invalid',
      `Say why you're changing production, in ${MIN_REASON_LENGTH} to ${MAX_REASON_LENGTH} characters.`,
    );
  }
  return reason;
}

function assertMayManageProduction(request: ChangeRequest): void {
  if (!request.canManageProduction) {
    throw new EnvironmentError('forbidden', 'Only people who manage production can do this.');
  }
}

function optionalReason(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const reason = normalizeName(value, {
    minLength: MIN_REASON_LENGTH,
    maxLength: MAX_REASON_LENGTH,
    refuseControlCharacters: true,
  });
  if (reason === null) {
    throw new EnvironmentError(
      'invalid',
      `Give a reason between ${MIN_REASON_LENGTH} and ${MAX_REASON_LENGTH} characters.`,
    );
  }
  return reason;
}
