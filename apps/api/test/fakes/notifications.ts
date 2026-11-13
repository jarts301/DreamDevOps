import type { EmailMessage, Mailer } from '../../src/notifications/application/ports.ts';

/** Keeps sent emails in memory instead of sending them. */
export class FakeMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  failing = false;

  async send(message: EmailMessage): Promise<void> {
    if (this.failing) {
      throw new Error('Mail server unavailable');
    }
    this.sent.push(message);
  }
}
