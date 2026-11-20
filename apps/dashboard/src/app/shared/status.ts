import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { BuildStatus } from '@dreamdevops/contracts/builds/http';
import type { DeploymentStatus } from '@dreamdevops/contracts/deployments/http';
import type { TargetStatus } from '@dreamdevops/contracts/environments/http';
import type { ReleaseStatus } from '@dreamdevops/contracts/releases/http';
import type { StepStatus } from './steps';

/**
 * The few states everything the dashboard follows can be in, so a build, a deployment and a
 * target that are doing the same thing look and read the same. "Inactive" is for what ended
 * without passing or failing, such as an aborted deployment, and says what happened instead.
 */
export type StatusState =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'awaiting-approval'
  | 'healthy'
  | 'degraded'
  | 'inactive';

/** A state, and a few words on where it stands, when the state alone doesn't say enough. */
export interface Status {
  readonly state: StatusState;
  readonly detail: string | null;
}

/** What each state is called everywhere. An inactive status is called by its detail. */
export const STATE_WORDS: Readonly<Record<Exclude<StatusState, 'inactive'>, string>> = {
  queued: 'Queued',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  'awaiting-approval': 'Waiting for approval',
  healthy: 'Healthy',
  degraded: 'Degraded',
};

/** Shown beside the word, so the state is clear without color. Screen readers hear the word. */
export const STATE_SYMBOLS: Readonly<Record<StatusState, string>> = {
  queued: '○',
  running: '◐',
  passed: '✓',
  failed: '✗',
  'awaiting-approval': '‖',
  healthy: '●',
  degraded: '▲',
  inactive: '–',
};

const status = (state: StatusState, detail: string | null = null): Status => ({ state, detail });

const BUILD: Readonly<Record<BuildStatus, Status>> = {
  queued: status('queued'),
  running: status('running'),
  succeeded: status('passed'),
  failed: status('failed'),
  deleted: status('inactive', 'Deleted'),
};

const STEP: Readonly<Record<StepStatus, Status>> = {
  pending: status('queued'),
  running: status('running'),
  passed: status('passed'),
  failed: status('failed'),
  skipped: status('inactive', 'Skipped'),
};

const DEPLOYMENT: Readonly<Record<DeploymentStatus, Status>> = {
  'awaiting-approval': status('awaiting-approval'),
  rejected: status('inactive', 'Rejected'),
  queued: status('queued'),
  committed: status('running', 'Waiting for the target'),
  progressing: status('running', 'Rolling out'),
  paused: status('awaiting-approval', 'Waiting to switch traffic'),
  succeeded: status('passed'),
  failed: status('failed'),
  aborted: status('inactive', 'Aborted'),
  superseded: status('inactive', 'Replaced by a newer deployment'),
};

const RELEASE: Readonly<Record<ReleaseStatus, Status>> = {
  open: status('running', 'Open'),
  merged: status('running', 'Building the final image'),
  published: status('passed', 'Published'),
};

const TARGET: Readonly<Record<TargetStatus, Status>> = {
  pending: status('queued', 'Waiting for the agent'),
  connected: status('healthy', 'Connected'),
  lost: status('degraded', 'Not reporting'),
  revoked: status('inactive', 'Disconnected'),
};

/** An unknown value, such as one a newer API added, shows as itself rather than breaking. */
const unknown = (value: string): Status => status('inactive', value);

export const buildStatus = (value: BuildStatus): Status => BUILD[value] ?? unknown(value);
export const stepStatus = (value: StepStatus): Status => STEP[value] ?? unknown(value);
export const deploymentStatus = (value: DeploymentStatus): Status => DEPLOYMENT[value] ?? unknown(value);
export const releaseStatus = (value: ReleaseStatus): Status => RELEASE[value] ?? unknown(value);
export const targetStatus = (value: TargetStatus): Status => TARGET[value] ?? unknown(value);

/** The word a status is shown with: its state's, or for an inactive one, what happened. */
export function statusWord(value: Status): string {
  return value.state === 'inactive' ? (value.detail ?? 'Inactive') : STATE_WORDS[value.state];
}

/** The detail shown after the word, if it adds anything. */
export function statusDetail(value: Status): string | null {
  return value.state === 'inactive' ? null : value.detail;
}

/** The status as one line of text, such as "Running · Rolling out". */
export function statusText(value: Status): string {
  const detail = statusDetail(value);
  return detail === null ? statusWord(value) : `${statusWord(value)} · ${detail}`;
}

/**
 * A status, the same way everywhere: a symbol, its state's word and color, and a few words
 * on where it stands when the state alone doesn't say enough.
 */
@Component({
  selector: 'app-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'status-badge' },
  template: `<span class="status" [attr.data-state]="status().state"
      >@if (symbol()) {<span class="status-symbol" aria-hidden="true">{{ STATE_SYMBOLS[status().state] }}</span>&ngsp;}{{ word() }}</span
    >@if (detail(); as text) {<span class="status-detail"><span class="visually-hidden">, </span>{{ text }}</span>}`,
})
export class StatusBadge {
  readonly status = input.required<Status>();
  /** Off where the symbol is shown already, such as beside a step's name. */
  readonly symbol = input(true);

  protected readonly STATE_SYMBOLS = STATE_SYMBOLS;
  protected readonly word = computed(() => statusWord(this.status()));
  protected readonly detail = computed(() => statusDetail(this.status()));
}
