import { describeError, type JobQueue, parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type { AlertEmails } from '../../notifications/application/alert-emails.ts';
import type { CompanyDirectory } from '../../tenancy/application/company-directory.ts';
import { describeCondition } from '../domain/alert.ts';
import type { AlertResolved, AlertTriggered } from '../domain/events.ts';
import { jobIdFor } from './job-ids.ts';

export const EMAIL_QUEUE = 'alerts.email';

/** One email about one change of an alert, to one address. */
export interface EmailJob {
  readonly event: AlertTriggered | AlertResolved;
  readonly to: string;
}

/**
 * Emails the addresses an alert names when it fires and when it's resolved. Each address
 * gets its own job, so one failing mailbox doesn't hold up or repeat the others.
 */
export class AlertDeliveries {
  readonly #database: TenantDatabase;
  readonly #companies: CompanyDirectory;
  readonly #emails: AlertEmails;

  constructor(database: TenantDatabase, companies: CompanyDirectory, emails: AlertEmails) {
    this.#database = database;
    this.#companies = companies;
    this.#emails = emails;
  }

  /**
   * Queues an email to each address the alert names now. An alert deleted meanwhile emails
   * nobody. The job ID makes each change reach each address once, even if the event
   * arrives twice.
   */
  async fanOut(event: AlertTriggered | AlertResolved, queue: JobQueue): Promise<void> {
    const recipients = await this.#database.transaction(async (tx) => {
      const { rows } = await tx.query<{ recipients: string[] }>('SELECT recipients FROM alerts.alerts WHERE id = $1', [
        event.payload.alertId,
      ]);
      return rows[0]?.recipients ?? [];
    });
    for (const to of recipients) {
      const job: EmailJob = { event, to };
      await queue.send(EMAIL_QUEUE, job, { id: jobIdFor('alert-email', event.eventId, to) });
    }
  }

  /** Sends one email. Throws to have the job tried again, and shows the failure on the alert meanwhile. */
  async deliver(job: EmailJob): Promise<void> {
    const { event, to } = job;
    await runWithCompany(parseCompanyId(event.companyId), async () => {
      const companyName = (await this.#companies.find(event.companyId))?.name ?? 'Your company';
      const payload = event.payload;
      try {
        await this.#emails.send({
          kind: event.eventType === 'AlertTriggered' ? 'firing' : 'resolved',
          to,
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
    await this.#database.transaction((tx) =>
      tx.query(
        `UPDATE alerts.alerts SET last_notification_error = $2,
           last_notified_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_notified_at END
         WHERE id = $1`,
        [alertId, error],
      ),
    );
  }
}
