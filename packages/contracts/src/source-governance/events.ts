import { z } from 'zod';
import { defineEvent, type EventOf } from '../event.ts';
import { id, name } from '../fields.ts';

/** Source governance's events: each application's repository. */

/** Someone asked for a repository to be created, or tried again after it failed. */
export const RepositoryRequested = defineEvent({
  type: 'RepositoryRequested',
  description: "An application's repository is asked for",
  payload: z.object({ applicationId: id() }),
  describe: () => "Asked for an application's repository to be created",
});

export const RepositoryCreated = defineEvent({
  type: 'RepositoryCreated',
  description: "An application's repository is ready",
  payload: z.object({
    applicationId: id(),
    name: name(),
    /** Its full name in the Git tool, such as acme/billing-api. */
    repository: name(),
    blueprint: name(),
    blueprintVersion: name(),
  }),
  describe: (payload) => `Created the repository ${payload.repository} for "${payload.name}"`,
  summarize: (payload) => `The repository of "${payload.name}" is ready: ${payload.repository}.`,
});

export const RepositoryCreationFailed = defineEvent({
  type: 'RepositoryCreationFailed',
  description: "Creating an application's repository fails",
  payload: z.object({ applicationId: id(), name: name(), reason: z.string() }),
  describe: (payload) => `Creating the repository of "${payload.name}" failed: ${payload.reason}`,
  summarize: (payload) => `Creating the repository of "${payload.name}" failed.`,
});

export type RepositoryRequested = EventOf<typeof RepositoryRequested>;
export type RepositoryCreated = EventOf<typeof RepositoryCreated>;
export type RepositoryCreationFailed = EventOf<typeof RepositoryCreationFailed>;

export const SOURCE_GOVERNANCE_EVENTS = [RepositoryRequested, RepositoryCreated, RepositoryCreationFailed] as const;
