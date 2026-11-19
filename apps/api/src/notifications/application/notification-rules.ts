import { NotificationTest } from '@dreamdevops/contracts/notifications/events';
import {
  currentCompanyId,
  describeError,
  deterministicJobId,
  type DomainEvent,
  isUuid,
  type JobQueue,
  parseCompanyId,
  runWithCompany,
} from '@dreamdevops/shared-kernel';
import type { Unchecked } from '@dreamdevops/contracts/http';
import type { Principal } from '@dreamdevops/contracts/identity-access/access';
import type {
  CreateRule,
  NotifiableEventType,
  RuleKind,
  RuleTestResult,
  RuleView,
  UpdateRule,
} from '@dreamdevops/contracts/notifications/http';
import { normalizeName } from '../../shared/names.ts';
import { NOTIFIABLE_EVENTS, summarize } from '../domain/event-catalog.ts';
import { NotificationError } from '../domain/errors.ts';
import type { CompanyNames } from './company-names.ts';
import { RefusedWebhookError, type RulesStore, type StoredRule, type WebhookSender } from './ports.ts';

export const DELIVERY_QUEUE = 'notifications.deliver';

export interface DeliveryJob {
  readonly ruleId: string;
  readonly event: DomainEvent;
}

export interface NotificationRulesOptions {
  /** Allows http:// addresses, for local testing only. */
  readonly allowInsecureWebhooks: boolean;
}

/** Company rules that post chosen events to a chat tool, and their delivery. */
export class NotificationRules {
  readonly #store: RulesStore;
  readonly #companies: CompanyNames;
  readonly #sender: WebhookSender;
  readonly #options: NotificationRulesOptions;

  constructor(store: RulesStore, companies: CompanyNames, sender: WebhookSender, options: NotificationRulesOptions) {
    this.#store = store;
    this.#companies = companies;
    this.#sender = sender;
    this.#options = options;
  }

  eventTypes(): NotifiableEventType[] {
    return Object.entries(NOTIFIABLE_EVENTS).map(([type, description]) => ({ type, description }));
  }

  list(): Promise<RuleView[]> {
    return this.#store.transaction(async (session) => (await session.list()).map(toView));
  }

  create(actor: Principal, input: Unchecked<CreateRule>): Promise<RuleView> {
    const name = ruleName(input.name);
    const kind = ruleKind(input.kind);
    const url = this.#webhookUrl(input.url);
    const eventTypes = chosenEvents(input.eventTypes);
    return this.#store.transaction(async (session) => toView(await session.add({ name, kind, url, eventTypes, createdBy: actor.userId })));
  }

  update(idValue: unknown, input: Unchecked<UpdateRule>): Promise<RuleView> {
    const id = ruleId(idValue);
    const name = input.name === undefined ? null : ruleName(input.name);
    const eventTypes = input.eventTypes === undefined ? null : chosenEvents(input.eventTypes);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      throw new NotificationError('invalid', 'Enabled must be true or false.');
    }
    const enabled = (input.enabled as boolean | undefined) ?? null;
    return this.#store.transaction(async (session) => {
      const rule = await session.update(id, { name, eventTypes, enabled });
      if (rule === null) {
        throw new NotificationError('not-found', 'This rule does not exist.');
      }
      return toView(rule);
    });
  }

  delete(idValue: unknown): Promise<void> {
    const id = ruleId(idValue);
    return this.#store.transaction(async (session) => {
      if (!(await session.delete(id))) {
        throw new NotificationError('not-found', 'This rule does not exist.');
      }
    });
  }

  /** Sends a sample message straight away, so an admin can check the address works. */
  async test(actor: Principal, idValue: unknown): Promise<RuleTestResult> {
    const rule = await this.#find(ruleId(idValue));
    if (rule === null) {
      throw new NotificationError('not-found', 'This rule does not exist.');
    }
    const event = NotificationTest.create({
      companyId: currentCompanyId(),
      actorId: actor.userId,
      payload: {},
    });
    try {
      await this.#sender.post(rule.url, message(rule.kind, event, `${actor.companyName ?? 'DreamDevOps'}: This is a test message from DreamDevOps.`, actor.companyName ?? ''));
      await this.#recordDelivery(rule.id, null);
      return { delivered: true, error: null };
    } catch (error) {
      const reason = describeError(error);
      await this.#recordDelivery(rule.id, reason);
      return { delivered: false, error: reason };
    }
  }

  /** Queues one delivery per matching rule, so each rule succeeds or retries on its own. */
  async fanOut(event: DomainEvent, queue: JobQueue): Promise<void> {
    if (NOTIFIABLE_EVENTS[event.eventType] === undefined) {
      return;
    }
    const ruleIds = await this.#store.transaction((session) => session.enabledFor(event.eventType));
    for (const ruleId of ruleIds) {
      const job: DeliveryJob = { ruleId, event };
      await queue.send(DELIVERY_QUEUE, job, { id: deliveryJobId(event.eventId, ruleId) });
    }
  }

  /** Delivers one event to one rule. Throws to have the job retried. */
  async deliver(job: DeliveryJob): Promise<void> {
    await runWithCompany(parseCompanyId(job.event.companyId), async () => {
      const rule = await this.#find(job.ruleId);
      if (rule === null || !rule.enabled) {
        return;
      }
      const companyName = await this.#companyName();
      try {
        await this.#sender.post(rule.url, message(rule.kind, job.event, summarize(job.event, companyName), companyName));
        await this.#recordDelivery(rule.id, null);
      } catch (error) {
        await this.#recordDelivery(rule.id, describeError(error));
        if (!(error instanceof RefusedWebhookError)) {
          throw error;
        }
      }
    });
  }

  #find(id: string): Promise<StoredRule | null> {
    return this.#store.transaction((session) => session.find(id));
  }

  async #companyName(): Promise<string> {
    return (await this.#companies.current()) ?? 'Your company';
  }

  async #recordDelivery(id: string, error: string | null): Promise<void> {
    await this.#store.transaction((session) => session.recordDelivery(id, error));
  }

  #webhookUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length > 2_000 || !URL.canParse(value)) {
      throw new NotificationError('invalid', 'Enter the full webhook address.');
    }
    const url = new URL(value);
    const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && this.#options.allowInsecureWebhooks);
    if (!allowed || url.username !== '' || url.password !== '') {
      throw new NotificationError('invalid', 'The webhook address must start with https:// and contain no password.');
    }
    return url.toString();
  }
}

/**
 * The job ID makes each event go to each rule once, even if it arrives twice. Job IDs
 * must be UUIDs, so this derives one from the pair.
 */
export function deliveryJobId(eventId: string, ruleId: string): string {
  return deterministicJobId(eventId, ruleId);
}

function message(kind: RuleKind, event: DomainEvent, text: string, companyName: string): object {
  if (kind === 'slack') {
    return { text };
  }
  return {
    text,
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    companyId: event.companyId,
    companyName,
    payload: event.payload,
  };
}

function toView(rule: StoredRule): RuleView {
  return {
    id: rule.id,
    name: rule.name,
    kind: rule.kind,
    destination: new URL(rule.url).origin,
    eventTypes: rule.eventTypes,
    enabled: rule.enabled,
    lastDeliveryAt: rule.lastDeliveryAt?.toISOString() ?? null,
    lastError: rule.lastError,
  };
}

function ruleId(value: unknown): string {
  if (!isUuid(value)) {
    throw new NotificationError('invalid', 'The rule ID is not valid.');
  }
  return value.toLowerCase();
}

function ruleName(value: unknown): string {
  // Unlike company and application names, rule names have never refused control characters.
  const name = normalizeName(value, { minLength: 2, maxLength: 80, refuseControlCharacters: false });
  if (name === null) {
    throw new NotificationError('invalid', 'Enter a rule name between 2 and 80 characters.');
  }
  return name;
}

function ruleKind(value: unknown): RuleKind {
  if (value !== 'slack' && value !== 'generic') {
    throw new NotificationError('invalid', 'Choose Slack or generic JSON.');
  }
  return value;
}

function chosenEvents(value: unknown): string[] {
  const types = Array.isArray(value) ? [...new Set(value)] : [];
  if (types.length === 0 || !types.every((type) => typeof type === 'string' && NOTIFIABLE_EVENTS[type] !== undefined)) {
    throw new NotificationError('invalid', 'Choose at least one event from the list.');
  }
  return types as string[];
}
