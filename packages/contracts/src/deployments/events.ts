import { z } from 'zod';
import { defineEvent, type EventOf } from '../event.ts';
import { id, name, reason } from '../fields.ts';
import { because } from '../text.ts';
import { DEPLOYMENT_ACTIONS, STRATEGIES } from './http.ts';

/** Deployments' events: a version of an application in an environment, from the request to its outcome. */

export const DeploymentRequested = defineEvent({
  type: 'DeploymentRequested',
  description: 'A deployment is asked for, or waits for approval',
  payload: z.object({
    deploymentId: id(),
    applicationId: id(),
    environmentId: id(),
    environmentName: name(),
    buildId: id(),
    strategy: z.enum(STRATEGIES),
    /** The deployment it rolls back, if it's a rollback. */
    rollbackOf: id().nullable(),
    action: z.enum(DEPLOYMENT_ACTIONS),
    needsApproval: z.boolean(),
    reason: reason(),
  }),
  describe: (payload) => {
    if (payload.action === 'stop') {
      return `Asked to stop an application in "${payload.environmentName}"${because(payload.reason)}`;
    }
    if (payload.action === 'apply') {
      return `Asked to apply the values of "${payload.environmentName}" to what runs there${because(payload.reason)}`;
    }
    return payload.rollbackOf !== null
      ? `Asked to roll back in "${payload.environmentName}"`
      : `Asked for a ${payload.strategy} deployment to "${payload.environmentName}"${payload.needsApproval ? ', which needs approval' : ''}`;
  },
  summarize: (payload) =>
    payload.needsApproval
      ? `A deployment to ${payload.environmentName} waits for approval.`
      : `A deployment to ${payload.environmentName} started.`,
});

/** Approved, or needing no approval, and waiting to be written to the environment's repository. */
export const DeploymentQueued = defineEvent({
  type: 'DeploymentQueued',
  description: 'A deployment is queued',
  payload: z.object({ deploymentId: id() }),
  describe: () => 'Queued a deployment',
});

const step = z.object({ deploymentId: id(), applicationId: id(), environmentName: name() });

export const DeploymentApproved = defineEvent({
  type: 'DeploymentApproved',
  description: 'A production deployment is approved',
  payload: step,
  describe: (payload) => `Approved a deployment to "${payload.environmentName}"`,
});

export const DeploymentRejected = defineEvent({
  type: 'DeploymentRejected',
  description: 'A production deployment is rejected',
  payload: step,
  describe: (payload) => `Rejected a deployment to "${payload.environmentName}"`,
  summarize: (payload) => `A deployment to ${payload.environmentName} was rejected.`,
});

/** Written to the environment's repository, for the target to apply. */
export const DeploymentStarted = defineEvent({
  type: 'DeploymentStarted',
  description: 'A deployment is written to its environment',
  payload: step.extend({ commit: name() }),
  describe: (payload) => `Committed a deployment to "${payload.environmentName}"`,
});

export const DeploymentPromoted = defineEvent({
  type: 'DeploymentPromoted',
  description: "A blue/green deployment's traffic switches to the new version",
  payload: step,
  describe: (payload) => `Switched traffic to the new version in "${payload.environmentName}"`,
});

export const DeploymentAbortRequested = defineEvent({
  type: 'DeploymentAbortRequested',
  description: 'Aborting a deployment is asked for',
  payload: step,
  describe: (payload) => `Asked to abort a deployment to "${payload.environmentName}"`,
});

const outcome = z.object({
  deploymentId: id(),
  applicationId: id(),
  applicationName: name(),
  environmentId: id(),
  environmentName: name(),
  version: name(),
  action: z.enum(DEPLOYMENT_ACTIONS),
  /** Why it failed or was aborted. */
  reason: z.string().optional(),
});

export const DeploymentSucceeded = defineEvent({
  type: 'DeploymentSucceeded',
  description: 'A deployment finishes',
  payload: outcome,
  describe: (payload) =>
    payload.action === 'stop'
      ? `Stopped ${payload.applicationName} in "${payload.environmentName}"`
      : `Deployed ${payload.applicationName} ${payload.version} to "${payload.environmentName}"`,
  summarize: (payload) => `${payload.applicationName} ${payload.version} runs in ${payload.environmentName}.`,
});

export const DeploymentFailed = defineEvent({
  type: 'DeploymentFailed',
  description: 'A deployment fails',
  payload: outcome,
  describe: (payload) =>
    `Deploying ${payload.applicationName} ${payload.version} to "${payload.environmentName}" failed: ${payload.reason ?? 'unknown reason'}`,
  summarize: (payload) => `Deploying ${payload.applicationName} ${payload.version} to ${payload.environmentName} failed.`,
});

export const DeploymentAborted = defineEvent({
  type: 'DeploymentAborted',
  description: 'A deployment is aborted',
  payload: outcome,
  describe: (payload) => `Aborted deploying ${payload.applicationName} ${payload.version} to "${payload.environmentName}"`,
  summarize: (payload) => `Deploying ${payload.applicationName} ${payload.version} to ${payload.environmentName} was aborted.`,
});

export type DeploymentRequested = EventOf<typeof DeploymentRequested>;
export type DeploymentQueued = EventOf<typeof DeploymentQueued>;
export type DeploymentApproved = EventOf<typeof DeploymentApproved>;
export type DeploymentRejected = EventOf<typeof DeploymentRejected>;
export type DeploymentStarted = EventOf<typeof DeploymentStarted>;
export type DeploymentPromoted = EventOf<typeof DeploymentPromoted>;
export type DeploymentAbortRequested = EventOf<typeof DeploymentAbortRequested>;
export type DeploymentSucceeded = EventOf<typeof DeploymentSucceeded>;
export type DeploymentFailed = EventOf<typeof DeploymentFailed>;
export type DeploymentAborted = EventOf<typeof DeploymentAborted>;

export const DEPLOYMENTS_EVENTS = [
  DeploymentRequested,
  DeploymentQueued,
  DeploymentApproved,
  DeploymentRejected,
  DeploymentStarted,
  DeploymentPromoted,
  DeploymentAbortRequested,
  DeploymentSucceeded,
  DeploymentFailed,
  DeploymentAborted,
] as const;
