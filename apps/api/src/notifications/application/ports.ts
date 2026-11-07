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
