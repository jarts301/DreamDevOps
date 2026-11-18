import { z } from 'zod';
import { defineEvent, type EventOf } from '../event.ts';
import { id, name, reason, timestamp } from '../fields.ts';
import { because } from '../text.ts';
import { HOSTING_PROVIDERS } from './hosting.ts';
import { ENVIRONMENT_KINDS } from './http.ts';

/**
 * Environments' events: each company's environments, the targets that run them, and their
 * variables and secrets. Changes to production carry the reason given for them.
 */

export const EnvironmentCreated = defineEvent({
  type: 'EnvironmentCreated',
  description: 'An environment is created',
  payload: z.object({
    environmentId: id(),
    name: name(),
    slug: name(),
    kind: z.enum(ENVIRONMENT_KINDS),
    acceptsFeatureImages: z.boolean(),
    reason: reason(),
  }),
  describe: (payload) => `Created the ${payload.kind} environment "${payload.name}"${because(payload.reason)}`,
  summarize: (payload) => `The ${payload.kind} environment ${payload.name} was created.`,
});

/** Only what changed is in it: its name, whether it takes feature images, or whether production deployments need approval. */
export const EnvironmentUpdated = defineEvent({
  type: 'EnvironmentUpdated',
  description: "An environment's settings change",
  payload: z.object({
    environmentId: id(),
    name: name().optional(),
    previousName: name().optional(),
    acceptsFeatureImages: z.boolean().optional(),
    requiresApproval: z.boolean().optional(),
    reason: reason(),
  }),
  describe: (payload) => {
    if (payload.name !== undefined) {
      return `Renamed the environment "${payload.previousName}" to "${payload.name}"${because(payload.reason)}`;
    }
    if (payload.acceptsFeatureImages !== undefined) {
      return payload.acceptsFeatureImages
        ? `Let an environment accept feature images${because(payload.reason)}`
        : `Stopped an environment from accepting feature images${because(payload.reason)}`;
    }
    return payload.requiresApproval === true
      ? `Required a second person's approval for an environment's deployments${because(payload.reason)}`
      : `Stopped requiring approval for an environment's deployments${because(payload.reason)}`;
  },
});

const status = z.object({ environmentId: id(), name: name(), reason: reason() });

export const EnvironmentArchived = defineEvent({
  type: 'EnvironmentArchived',
  description: 'An environment is archived',
  payload: status,
  describe: (payload) => `Archived the environment "${payload.name}"${because(payload.reason)}`,
  summarize: (payload) => `The environment ${payload.name} was archived.`,
});

export const EnvironmentRestored = defineEvent({
  type: 'EnvironmentRestored',
  description: 'An archived environment is restored',
  payload: status,
  describe: (payload) => `Restored the environment "${payload.name}"`,
});

const target = { environmentId: id(), environmentName: name(), targetId: id() };

export const TargetRegistrationStarted = defineEvent({
  type: 'TargetRegistrationStarted',
  description: 'A command to connect a target is made',
  payload: z.object(target),
  describe: (payload) => `Created a command to connect a target to "${payload.environmentName}"`,
});

/**
 * A target connected: This machine, which needs no agent and names its provider, or a
 * cluster's agent, which names its key's fingerprint and whether it had been lost.
 */
export const TargetConnected = defineEvent({
  type: 'TargetConnected',
  description: 'A target connects, or reconnects after being lost',
  payload: z.object({
    ...target,
    provider: z.enum(HOSTING_PROVIDERS).optional(),
    keyFingerprint: z.string().optional(),
    reconnected: z.boolean().optional(),
  }),
  describe: (payload) => {
    if (payload.provider === 'local') {
      return `Set "${payload.environmentName}" to run on this machine`;
    }
    return payload.reconnected === true
      ? `The target of "${payload.environmentName}" is reporting again`
      : `Connected a target to "${payload.environmentName}", key ${payload.keyFingerprint}`;
  },
  summarize: (payload) =>
    payload.reconnected === true
      ? `The target of ${payload.environmentName} is reporting again.`
      : `A target connected to ${payload.environmentName}.`,
});

export const TargetLost = defineEvent({
  type: 'TargetLost',
  description: 'A target stops reporting',
  payload: z.object({ ...target, lastSeenAt: timestamp() }),
  describe: (payload) => `The target of "${payload.environmentName}" stopped reporting`,
  summarize: (payload) => `The target of ${payload.environmentName} stopped reporting.`,
});

/** A target was disconnected, or, if it never connected, connecting it was cancelled. */
export const TargetRevoked = defineEvent({
  type: 'TargetRevoked',
  description: 'A target is disconnected',
  payload: z.object({ ...target, provider: z.enum(HOSTING_PROVIDERS), wasConnected: z.boolean(), reason: reason() }),
  describe: (payload) =>
    payload.wasConnected
      ? `Disconnected the target of "${payload.environmentName}"${because(payload.reason)}`
      : `Cancelled connecting a target to "${payload.environmentName}"`,
  summarize: (payload) => `The target of ${payload.environmentName} was disconnected.`,
});

/** A variable or secret, for every application in the environment, or for one, which it names. */
const value = z.object({
  environmentId: id(),
  environmentName: name(),
  applicationId: id().nullable(),
  name: name(),
  reason: reason(),
});
const forWhom = (payload: { readonly applicationId: string | null }) => (payload.applicationId === null ? '' : ' for one application');

export const EnvironmentVariableSet = defineEvent({
  type: 'EnvironmentVariableSet',
  description: "An environment's variable is set",
  payload: value,
  describe: (payload) => `Set the variable ${payload.name} in "${payload.environmentName}"${forWhom(payload)}${because(payload.reason)}`,
});

export const EnvironmentVariableRemoved = defineEvent({
  type: 'EnvironmentVariableRemoved',
  description: "An environment's variable is removed",
  payload: value,
  describe: (payload) => `Removed the variable ${payload.name} from "${payload.environmentName}"${because(payload.reason)}`,
});

/** A secret's name only: its value stays in the secret store. */
export const EnvironmentSecretSet = defineEvent({
  type: 'EnvironmentSecretSet',
  description: "An environment's secret is set",
  payload: value,
  describe: (payload) => `Set the secret ${payload.name} in "${payload.environmentName}"${forWhom(payload)}${because(payload.reason)}`,
  summarize: (payload) => `The secret ${payload.name} was set in ${payload.environmentName}.`,
});

export const EnvironmentSecretRemoved = defineEvent({
  type: 'EnvironmentSecretRemoved',
  description: "An environment's secret is removed",
  payload: value,
  describe: (payload) => `Removed the secret ${payload.name} from "${payload.environmentName}"${because(payload.reason)}`,
});

export type EnvironmentCreated = EventOf<typeof EnvironmentCreated>;
export type EnvironmentUpdated = EventOf<typeof EnvironmentUpdated>;
export type EnvironmentArchived = EventOf<typeof EnvironmentArchived>;
export type EnvironmentRestored = EventOf<typeof EnvironmentRestored>;
export type TargetRegistrationStarted = EventOf<typeof TargetRegistrationStarted>;
export type TargetConnected = EventOf<typeof TargetConnected>;
export type TargetLost = EventOf<typeof TargetLost>;
export type TargetRevoked = EventOf<typeof TargetRevoked>;
export type EnvironmentVariableSet = EventOf<typeof EnvironmentVariableSet>;
export type EnvironmentVariableRemoved = EventOf<typeof EnvironmentVariableRemoved>;
export type EnvironmentSecretSet = EventOf<typeof EnvironmentSecretSet>;
export type EnvironmentSecretRemoved = EventOf<typeof EnvironmentSecretRemoved>;

export const ENVIRONMENTS_EVENTS = [
  EnvironmentCreated,
  EnvironmentUpdated,
  EnvironmentArchived,
  EnvironmentRestored,
  TargetRegistrationStarted,
  TargetConnected,
  TargetLost,
  TargetRevoked,
  EnvironmentVariableSet,
  EnvironmentVariableRemoved,
  EnvironmentSecretSet,
  EnvironmentSecretRemoved,
] as const;
