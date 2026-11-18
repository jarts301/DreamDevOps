import { z } from 'zod';
import { defineEvent, type EventOf } from '../event.ts';
import { id, name } from '../fields.ts';

/** Tenancy's events: the company's life, and the setting up of its resources, such as its Git organization. */

export const CompanyCreated = defineEvent({
  type: 'CompanyCreated',
  description: 'A company is created',
  payload: z.object({ name: name(), slug: name(), createdBy: id() }),
  describe: (payload) => `Created the company "${payload.name}"`,
});

export const CompanyRenamed = defineEvent({
  type: 'CompanyRenamed',
  description: 'The company is renamed',
  payload: z.object({ name: name(), previousName: name(), renamedBy: id() }),
  describe: (payload) => `Renamed the company from "${payload.previousName}" to "${payload.name}"`,
  summarize: (payload) => `The company was renamed from "${payload.previousName}".`,
});

export const CompanySuspended = defineEvent({
  type: 'CompanySuspended',
  description: 'The company is suspended',
  payload: z.object({ suspendedBy: id() }),
  describe: () => 'Suspended the company',
  summarize: () => 'The company was suspended.',
});

export const CompanyReactivated = defineEvent({
  type: 'CompanyReactivated',
  description: 'The company is reactivated',
  payload: z.object({ reactivatedBy: id() }),
  describe: () => 'Reactivated the company',
  summarize: () => 'The company was reactivated.',
});

/** A platform admin asked for the company's resources to be set up again, or reactivating it did. */
export const CompanyProvisioningRequested = defineEvent({
  type: 'CompanyProvisioningRequested',
  description: "The company's setup is asked for again",
  payload: z.object({ requestedBy: id().optional() }),
  describe: () => 'Asked for the company to be set up',
});

export const CompanyProvisioned = defineEvent({
  type: 'CompanyProvisioned',
  description: 'The company finishes setting up',
  payload: z.object({}),
  describe: () => 'Finished setting up the company',
  summarize: () => 'The company finished setting up.',
});

export const CompanyProvisioningFailed = defineEvent({
  type: 'CompanyProvisioningFailed',
  description: 'Setting up the company fails',
  payload: z.object({ reason: z.string() }),
  describe: (payload) => `Setting up the company failed: ${payload.reason}`,
  summarize: () => 'Setting up the company failed.',
});

export type CompanyCreated = EventOf<typeof CompanyCreated>;
export type CompanyRenamed = EventOf<typeof CompanyRenamed>;
export type CompanySuspended = EventOf<typeof CompanySuspended>;
export type CompanyReactivated = EventOf<typeof CompanyReactivated>;
export type CompanyProvisioningRequested = EventOf<typeof CompanyProvisioningRequested>;
export type CompanyProvisioned = EventOf<typeof CompanyProvisioned>;
export type CompanyProvisioningFailed = EventOf<typeof CompanyProvisioningFailed>;

export const TENANCY_EVENTS = [
  CompanyCreated,
  CompanyRenamed,
  CompanySuspended,
  CompanyReactivated,
  CompanyProvisioningRequested,
  CompanyProvisioned,
  CompanyProvisioningFailed,
] as const;
