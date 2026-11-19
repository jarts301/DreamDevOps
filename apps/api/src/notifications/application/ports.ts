import type { RuleKind } from '@dreamdevops/contracts/notifications/http';
import type { Transactional } from '@dreamdevops/shared-kernel';

export const MAILER = Symbol('MAILER');
export const WEBHOOK_SENDER = Symbol('WEBHOOK_SENDER');

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

/** Posts JSON to a webhook. Throws on anything but a 2xx response. */
export interface WebhookSender {
  post(url: string, body: object): Promise<void>;
}

/** The address itself is refused, so retrying won't help. */
export class RefusedWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedWebhookError';
  }
}

/** A chat rule as Notifications keeps it, with its whole address, which is often a secret. */
export interface StoredRule {
  readonly id: string;
  readonly name: string;
  readonly kind: RuleKind;
  readonly url: string;
  readonly eventTypes: readonly string[];
  readonly enabled: boolean;
  readonly lastDeliveryAt: Date | null;
  readonly lastError: string | null;
}

/** The current company's chat rules, in one transaction. */
export interface RulesSession {
  /** Every rule, by name. */
  list(): Promise<StoredRule[]>;
  find(id: string): Promise<StoredRule | null>;
  add(rule: {
    readonly name: string;
    readonly kind: RuleKind;
    readonly url: string;
    readonly eventTypes: readonly string[];
    readonly createdBy: string;
  }): Promise<StoredRule>;
  /** Changes what's given, and keeps the rest. Null when there's no such rule. */
  update(
    id: string,
    changes: { readonly name: string | null; readonly eventTypes: readonly string[] | null; readonly enabled: boolean | null },
  ): Promise<StoredRule | null>;
  /** False when there's no such rule. */
  delete(id: string): Promise<boolean>;
  /** The IDs of the turned-on rules that post an event type. */
  enabledFor(eventType: string): Promise<string[]>;
  /** Records when a rule last posted, and why it failed, if it did. */
  recordDelivery(id: string, error: string | null): Promise<void>;
}

export const RULES_STORE = Symbol('RULES_STORE');

export type RulesStore = Transactional<RulesSession>;

/** The current company's name, as Notifications keeps it, in one transaction. */
export interface CompanyNamesSession {
  /** Null when Notifications hasn't heard the company's name yet. */
  name(): Promise<string | null>;
  /** Keeps the name given at that time, unless the name kept was given later. */
  named(name: string, at: Date): Promise<void>;
  /** Keeps the name only if there's none yet. */
  rememberIfUnknown(name: string): Promise<void>;
}

export const COMPANY_NAMES_STORE = Symbol('COMPANY_NAMES_STORE');

export type CompanyNamesStore = Transactional<CompanyNamesSession>;
