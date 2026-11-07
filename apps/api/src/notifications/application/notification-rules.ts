import { createHash } from 'node:crypto';
import {
  createDomainEvent,
  currentCompanyId,
  type DomainEvent,
  type JobQueue,
  parseCompanyId,
  runWithCompany,
} from '@dreamdevops/shared-kernel';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type { Principal } from '../../identity-access/domain/access.ts';
import { NOTIFIABLE_EVENTS, summarize } from '../domain/event-catalog.ts';
import { NotificationError } from '../domain/errors.ts';
import { RefusedWebhookError, type WebhookSender } from './ports.ts';

export const DELIVERY_QUEUE = 'notifications.deliver';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RuleKind = 'slack' | 'generic';

export interface RuleView {
  readonly id: string;
  readonly name: string;
  readonly kind: RuleKind;
  /** Only the address's origin, because the rest is often a secret. */
  readonly destination: string;
  readonly eventTypes: readonly string[];
  readonly enabled: boolean;
  readonly lastDeliveryAt: string | null;
  readonly lastError: string | null;
}

interface RuleRow {
  id: string;
  name: string;
  kind: RuleKind;
  url: string;
  event_types: string[];
  enabled: boolean;
  last_delivery_at: Date | null;
  last_error: string | null;
}

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
  readonly #database: TenantDatabase;
  readonly #sender: WebhookSender;
  readonly #options: NotificationRulesOptions;

  constructor(database: TenantDatabase, sender: WebhookSender, options: NotificationRulesOptions) {
    this.#database = database;
    this.#sender = sender;
    this.#options = options;
  }

  eventTypes(): { type: string; description: string }[] {
    return Object.entries(NOTIFIABLE_EVENTS).map(([type, description]) => ({ type, description }));
  }

  list(): Promise<RuleView[]> {
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<RuleRow>('SELECT * FROM notification.rules ORDER BY lower(name), id');
      return rows.map(toView);
    });
  }

  create(actor: Principal, input: { name?: unknown; kind?: unknown; url?: unknown; eventTypes?: unknown }): Promise<RuleView> {
    const name = ruleName(input.name);
    const kind = ruleKind(input.kind);
    const url = this.#webhookUrl(input.url);
    const eventTypes = chosenEvents(input.eventTypes);
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<RuleRow>(
        `INSERT INTO notification.rules (company_id, name, kind, url, event_types, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [currentCompanyId(), name, kind, url, eventTypes, actor.userId],
      );
      return toView(rows[0]!);
    });
  }

  update(idValue: unknown, input: { name?: unknown; eventTypes?: unknown; enabled?: unknown }): Promise<RuleView> {
    const id = ruleId(idValue);
    const name = input.name === undefined ? null : ruleName(input.name);
    const eventTypes = input.eventTypes === undefined ? null : chosenEvents(input.eventTypes);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      throw new NotificationError('invalid', 'Enabled must be true or false.');
    }
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<RuleRow>(
        `UPDATE notification.rules SET
           name = coalesce($2, name),
           event_types = coalesce($3, event_types),
           enabled = coalesce($4, enabled),
           updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [id, name, eventTypes, input.enabled ?? null],
      );
      if (rows[0] === undefined) {
        throw new NotificationError('not-found', 'This rule does not exist.');
      }
      return toView(rows[0]);
    });
  }

  delete(idValue: unknown): Promise<void> {
    const id = ruleId(idValue);
    return this.#database.transaction(async (tx) => {
      const { rowCount } = await tx.query('DELETE FROM notification.rules WHERE id = $1', [id]);
      if (rowCount === 0) {
        throw new NotificationError('not-found', 'This rule does not exist.');
      }
    });
  }

  /** Sends a sample message straight away, so an admin can check the address works. */
  async test(actor: Principal, idValue: unknown): Promise<{ delivered: boolean; error: string | null }> {
    const rule = await this.#find(ruleId(idValue));
    if (rule === null) {
      throw new NotificationError('not-found', 'This rule does not exist.');
    }
    const event = createDomainEvent({
      eventType: 'NotificationTest',
      companyId: currentCompanyId(),
      actorId: actor.userId,
      payload: {},
    });
    try {
      await this.#sender.post(rule.url, message(rule.kind, event, `${actor.companyName ?? 'DreamDevOps'}: This is a test message from DreamDevOps.`, actor.companyName ?? ''));
      await this.#recordDelivery(rule.id, null);
      return { delivered: true, error: null };
    } catch (error) {
      const reason = describe(error);
      await this.#recordDelivery(rule.id, reason);
      return { delivered: false, error: reason };
    }
  }

  /** Queues one delivery per matching rule, so each rule succeeds or retries on its own. */
  async fanOut(event: DomainEvent, queue: JobQueue): Promise<void> {
    if (NOTIFIABLE_EVENTS[event.eventType] === undefined) {
      return;
    }
    const ruleIds = await this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM notification.rules WHERE enabled AND $1 = ANY (event_types)',
        [event.eventType],
      );
      return rows.map((row) => row.id);
    });
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
        await this.#recordDelivery(rule.id, describe(error));
        if (!(error instanceof RefusedWebhookError)) {
          throw error;
        }
      }
    });
  }

  async #find(id: string): Promise<RuleRow | null> {
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<RuleRow>('SELECT * FROM notification.rules WHERE id = $1', [id]);
      return rows[0] ?? null;
    });
  }

  async #companyName(): Promise<string> {
    return this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<{ name: string }>('SELECT name FROM tenancy.companies WHERE id = $1', [
        currentCompanyId(),
      ]);
      return rows[0]?.name ?? 'Your company';
    });
  }

  async #recordDelivery(id: string, error: string | null): Promise<void> {
    await this.#database.transaction((tx) =>
      tx.query('UPDATE notification.rules SET last_delivery_at = now(), last_error = $2 WHERE id = $1', [id, error]),
    );
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
  const hex = createHash('sha256').update(`${eventId}:${ruleId}`).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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

function toView(row: RuleRow): RuleView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    destination: new URL(row.url).origin,
    eventTypes: row.event_types,
    enabled: row.enabled,
    lastDeliveryAt: row.last_delivery_at?.toISOString() ?? null,
    lastError: row.last_error,
  };
}

function ruleId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new NotificationError('invalid', 'The rule ID is not valid.');
  }
  return value.toLowerCase();
}

function ruleName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 80) {
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

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : 'Unknown error').slice(0, 300);
}
