import {
  type CompanyId,
  createDomainEvent,
  type DomainEvent,
  type EventContract,
  InvalidEventPayloadError,
} from '@dreamdevops/shared-kernel';
import { z } from 'zod';

/** The fields of a new event, besides its type and version, which its contract sets. */
export interface NewEvent<TPayload> {
  readonly companyId: CompanyId;
  /** The user who caused it, or null when the platform did it on its own. */
  readonly actorId?: string | null;
  readonly payload: TPayload;
  readonly occurredAt?: Date;
  readonly eventId?: string;
}

/** What every event's contract says of it, whatever its payload, such as for lists of events. */
export interface EventInfo {
  readonly type: string;
  readonly version: number;
  /** What happens, for people choosing what to hear about, such as "An application is registered". */
  readonly description: string;
}

/**
 * An event a context publishes: its name, its version, the shape of its payload, and how
 * it reads to people. The publisher creates events only through it, and consumers read
 * them only through it, so the contract is the one place that says what the event is.
 *
 * A change to a payload must stay compatible: add optional fields only. Anything else,
 * such as removing or renaming a field, is a new version: a second contract with the same
 * type and the next version, which the event bus delivers on a topic of its own. Consumers
 * subscribe to the new version alongside the old one first, then the publisher moves to
 * it, and the old contract goes once none of its events are left to deliver.
 */
export interface EventDefinition<TType extends string = string, TPayload extends object = object>
  extends EventContract<DomainEvent<TType, TPayload>>,
    EventInfo {
  readonly type: TType;
  readonly payload: z.ZodType<TPayload>;
  /** A new event of this type. Throws if the payload doesn't hold to the contract, which is a bug in the publisher. */
  create(event: NewEvent<TPayload>): DomainEvent<TType, TPayload>;
  /** The event, checked against the contract. Throws InvalidEventPayloadError if it doesn't hold. */
  parse(event: DomainEvent): DomainEvent<TType, TPayload>;
  /** One line for the history, as who caused it did it, such as 'Registered the application "Billing API"'. */
  describe(payload: TPayload): string;
  /** One sentence for a chat message, such as 'The application "Billing API" was registered.' */
  summarize(payload: TPayload): string;
}

/** The event an event definition describes. */
export type EventOf<TDefinition> = TDefinition extends EventDefinition<infer TType, infer TPayload> ? DomainEvent<TType, TPayload> : never;

/** The payload of the event an event definition describes. */
export type PayloadOf<TDefinition> = TDefinition extends EventDefinition<string, infer TPayload> ? TPayload : never;

/** Defines an event's contract. See EventDefinition. */
export function defineEvent<const TType extends string, TSchema extends z.ZodObject>(definition: {
  readonly type: TType;
  readonly version?: number;
  readonly description: string;
  readonly payload: TSchema;
  readonly describe: (payload: z.output<TSchema>) => string;
  /** Defaults to the description. Events people can be notified about say more. */
  readonly summarize?: (payload: z.output<TSchema>) => string;
}): EventDefinition<TType, z.output<TSchema>> {
  type Payload = z.output<TSchema>;
  const version = definition.version ?? 1;
  // New events must have exactly the contract's fields, so a field the contract forgot
  // fails the publisher's tests rather than being dropped. Consumers accept fields they
  // don't know, so publishers can add optional ones without breaking them.
  const exact = definition.payload.strict();

  return {
    type: definition.type,
    version,
    description: definition.description,
    payload: definition.payload as unknown as z.ZodType<Payload>,
    create(event: NewEvent<Payload>): DomainEvent<TType, Payload> {
      const checked = exact.safeParse(event.payload);
      if (!checked.success) {
        throw new Error(`A new ${definition.type} event doesn't hold to its contract:\n${z.prettifyError(checked.error)}`);
      }
      return createDomainEvent({ ...event, eventType: definition.type, eventVersion: version });
    },
    parse(event: DomainEvent): DomainEvent<TType, Payload> {
      if (event.eventType !== definition.type) {
        throw new InvalidEventPayloadError(event, `it's a ${event.eventType} event, not ${definition.type}.`);
      }
      if (event.eventVersion !== version) {
        throw new InvalidEventPayloadError(event, `its version is ${event.eventVersion}, and this contract reads version ${version}.`);
      }
      const checked = definition.payload.safeParse(event.payload);
      if (!checked.success) {
        throw new InvalidEventPayloadError(event, z.prettifyError(checked.error));
      }
      return { ...event, eventType: definition.type, payload: checked.data as Payload };
    },
    describe: definition.describe,
    summarize: definition.summarize ?? (() => `${definition.description}.`),
  };
}
