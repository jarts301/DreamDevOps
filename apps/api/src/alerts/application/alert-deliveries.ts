import { describeError, deterministicJobId, type JobQueue, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { CompanyMembers } from '@dreamdevops/contracts/identity-access/services';
import type { AlertMailer } from '@dreamdevops/contracts/notifications/services';
import type { CompanyDirectory } from '@dreamdevops/contracts/tenancy/services';
import { describeCondition } from '../domain/alert.ts';
import type { AlertResolved, AlertTriggered } from '@dreamdevops/contracts/alerts/events';
import type { AlertsStore } from './ports.ts';

export const EMAIL_QUEUE = 'alerts.email';

/**
 * One email about one change of an alert, to one member. It names the member, not their
 * address, which is looked up as it's sent.
 */
export interface EmailJob {
  readonly event: AlertTriggered | AlertResolved;
  readonly userId: string;
}

/**
 * Emails the members an alert names when it fires and when it's resolved. Each member
 * gets their own job, so one failing mailbox doesn't hold up or repeat the others. Only
 * people who are members when the email is sent get it, at their address then.
 */
export class AlertDeliveries {
  readonly #store: AlertsStore;
  readonly #companies: CompanyDirectory;
  readonly #emails: AlertMailer;
  readonly #members: CompanyMembers;

  constructor(store: AlertsStore, companies: CompanyDirectory, emails: AlertMailer, members: CompanyMembers) {
    this.#store = store;
    this.#companies = companies;
    this.#emails = emails;
    this.#members = members;
  }

  /**
   * Queues an email to each member the alert names now. An alert deleted meanwhile emails
   * nobody, and nor does anyone no longer in the company. The job ID makes each change
   * reach each member once, even if the event arrives twice.
   */
  async fanOut(event: AlertTriggered | AlertResolved, queue: JobQueue): Promise<void> {
    const alert = await this.#store.transaction((session) => session.find(event.payload.alertId));
    const recipientIds = alert?.recipientIds ?? [];
    for (const member of await this.#members.find(recipientIds)) {
      const job: EmailJob = { event, userId: member.userId };
      await queue.send(EMAIL_QUEUE, job, { id: deterministicJobId('alert-email', event.eventId, member.userId) });
    }
  }

  /** Sends one email. Throws to have the job tried again, and shows the failure on the alert meanwhile. */
  async deliver(job: EmailJob): Promise<void> {
    const { event, userId } = job;
    await runWithCompany(parseCompanyId(event.companyId), async () => {
      // Checked again as it's sent: someone removed since the alert fired isn't emailed.
      const [member] = await this.#members.find(typeof userId === 'string' ? [userId] : []);
      if (member === undefined) {
        return;
      }
      const companyName = (await this.#companies.find(event.companyId))?.name ?? 'Your company';
      const payload = event.payload;
      try {
        await this.#emails.send({
          kind: event.eventType === 'AlertTriggered' ? 'firing' : 'resolved',
          to: member.email,
          companyName,
          alertName: payload.name,
          applicationName: payload.applicationName,
          environmentName: payload.environmentName,
          production: payload.production,
          condition: describeCondition(payload, { withDuration: true }),
          value: payload.value,
          firingSince: payload.firingSince,
          at: event.eventType === 'AlertResolved' ? event.payload.resolvedAt : event.occurredAt,
        });
      } catch (error) {
        await this.#record(payload.alertId, describeError(error));
        throw error;
      }
      await this.#record(payload.alertId, null);
    });
  }

  async #record(alertId: string, error: string | null): Promise<void> {
    await this.#store.transaction((session) => session.recordNotification(alertId, { notified: error === null, error }));
  }
}
