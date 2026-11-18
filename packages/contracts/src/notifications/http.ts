/** Notifications' HTTP API, as the dashboard sees it. Types only, so a browser app can use them. */

export type RuleKind = 'slack' | 'generic';

/** A rule that posts chosen events to a chat tool. */
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

/** An event people can be told about. */
export interface NotifiableEventType {
  readonly type: string;
  /** What happens, such as "An application is registered". */
  readonly description: string;
}

export interface CreateRule {
  readonly name: string;
  readonly kind: RuleKind;
  /** The chat tool's incoming webhook address. */
  readonly url: string;
  readonly eventTypes: readonly string[];
}

/** Changes a rule. Fields left out stay as they are. */
export interface UpdateRule {
  readonly name?: string;
  readonly eventTypes?: readonly string[];
  readonly enabled?: boolean;
}

/** How a test message went. */
export interface RuleTestResult {
  readonly delivered: boolean;
  readonly error: string | null;
}
