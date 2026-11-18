import { z } from 'zod';
import { defineEvent, type EventOf } from '../event.ts';
import { id } from '../fields.ts';
import { editionName } from './features.ts';

/** Editions' events. */

const edition = () => z.enum(['community', 'commercial']);

export const CompanyEditionChanged = defineEvent({
  type: 'CompanyEditionChanged',
  description: "The company's edition changes",
  payload: z.object({ edition: edition(), previousEdition: edition(), changedBy: id() }),
  describe: (payload) => `Moved the company from the ${editionName(payload.previousEdition)} to the ${editionName(payload.edition)} Edition`,
  summarize: (payload) => `The company moved to the ${editionName(payload.edition)} Edition.`,
});

export type CompanyEditionChanged = EventOf<typeof CompanyEditionChanged>;

export const EDITIONS_EVENTS = [CompanyEditionChanged] as const;
