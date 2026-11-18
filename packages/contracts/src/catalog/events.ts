import { z } from 'zod';
import { defineEvent, type EventOf } from '../event.ts';
import { id, name } from '../fields.ts';

/** The application catalog's events. */

export const ApplicationRegistered = defineEvent({
  type: 'ApplicationRegistered',
  description: 'An application is registered',
  payload: z.object({
    applicationId: id(),
    name: name(),
    slug: name(),
    /** The application type's key, such as restful-service. */
    type: name(),
    /**
     * The blueprint chosen for it, such as react-typescript-frontend. Events of applications
     * registered before blueprints were chosen don't have it: they started from their type's
     * only blueprint.
     */
    blueprint: name().optional(),
  }),
  describe: (payload) => `Registered the application "${payload.name}"`,
  summarize: (payload) => `The application "${payload.name}" was registered.`,
});

/** A rename names the old and new names. A changed description only says so, as it can be long. */
export const ApplicationUpdated = defineEvent({
  type: 'ApplicationUpdated',
  description: 'An application is renamed or its description changes',
  payload: z.object({
    applicationId: id(),
    name: name().optional(),
    previousName: name().optional(),
    descriptionChanged: z.boolean(),
  }),
  describe: (payload) =>
    payload.name === undefined
      ? "Changed an application's description"
      : `Renamed the application "${payload.previousName}" to "${payload.name}"`,
  summarize: (payload) =>
    payload.name === undefined
      ? "An application's description changed."
      : `The application "${payload.previousName}" was renamed to "${payload.name}".`,
});

const status = z.object({ applicationId: id(), name: name() });

export const ApplicationArchived = defineEvent({
  type: 'ApplicationArchived',
  description: 'An application is archived',
  payload: status,
  describe: (payload) => `Archived the application "${payload.name}"`,
  summarize: (payload) => `The application "${payload.name}" was archived.`,
});

export const ApplicationRestored = defineEvent({
  type: 'ApplicationRestored',
  description: 'An archived application is restored',
  payload: status,
  describe: (payload) => `Restored the application "${payload.name}"`,
  summarize: (payload) => `The application "${payload.name}" was restored.`,
});

export type ApplicationRegistered = EventOf<typeof ApplicationRegistered>;
export type ApplicationUpdated = EventOf<typeof ApplicationUpdated>;
export type ApplicationArchived = EventOf<typeof ApplicationArchived>;
export type ApplicationRestored = EventOf<typeof ApplicationRestored>;

export const CATALOG_EVENTS = [ApplicationRegistered, ApplicationUpdated, ApplicationArchived, ApplicationRestored] as const;
