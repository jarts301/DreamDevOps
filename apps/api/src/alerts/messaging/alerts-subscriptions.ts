import { Logger } from '@nestjs/common';
import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import type { AlertChecks } from '../application/alert-checks.ts';
import { type AlertDeliveries, EMAIL_QUEUE, type EmailJob } from '../application/alert-deliveries.ts';
import { jobIdFor } from '../application/job-ids.ts';
import type { AlertResolved, AlertTriggered } from '../domain/events.ts';

/** Sent every minute, on a schedule every API process shares, to check every company's alerts. */
export const CHECK_QUEUE = 'alerts.check';
/** One job per company and minute, so one company's slow or failing check doesn't hold up another's. */
export const EVALUATE_QUEUE = 'alerts.evaluate';
/** Every minute, in UTC. */
export const CHECK_SCHEDULE = '* * * * *';

interface EvaluateJob {
  readonly companyId: string;
}

/**
 * Checks alerts every minute, and emails people when they fire and when they're resolved.
 * A check that fails isn't tried again: the next minute's check takes its place.
 */
export class AlertsSubscriptions implements BackgroundSubscriber {
  readonly #logger = new Logger(AlertsSubscriptions.name);
  readonly #checks: AlertChecks;
  readonly #deliveries: AlertDeliveries;
  readonly #config: AppConfig;
  readonly #now: () => Date;

  constructor(checks: AlertChecks, deliveries: AlertDeliveries, config: AppConfig, now: () => Date = () => new Date()) {
    this.#checks = checks;
    this.#deliveries = deliveries;
    this.#config = config;
    this.#now = now;
  }

  async subscribe({ bus, queue }: BackgroundWork): Promise<void> {
    await queue.createQueue(EVALUATE_QUEUE, { retryLimit: 0, expireInSeconds: 120 });
    await queue.work(EVALUATE_QUEUE, async (job) => {
      const { companyId } = job.data as EvaluateJob;
      const summary = await runWithCompany(parseCompanyId(companyId), () => this.#checks.check());
      if (summary.problem !== null) {
        this.#logger.warn(`Alerts of company ${companyId} weren't checked: ${summary.problem}`);
      }
    });

    await queue.createQueue(CHECK_QUEUE, { retryLimit: 0, expireInSeconds: 120 });
    await queue.work(CHECK_QUEUE, async () => {
      // The job ID names the company and the minute, so a company is checked once a minute.
      const minute = Math.floor(this.#now().getTime() / 60_000);
      for (const companyId of await this.#checks.companiesToCheck()) {
        const job: EvaluateJob = { companyId };
        await queue.send(EVALUATE_QUEUE, job, { id: jobIdFor('alerts-check', companyId, String(minute)) });
      }
    });

    await queue.createQueue(EMAIL_QUEUE, { retryLimit: 4, retryDelaySeconds: this.#config.notificationRetrySeconds });
    await queue.work(EMAIL_QUEUE, (job) => this.#deliveries.deliver(job.data as EmailJob));
    const fanOut = (event: AlertTriggered | AlertResolved) => this.#deliveries.fanOut(event, queue);
    await bus.subscribe<AlertTriggered>('AlertTriggered', 'alerts-email', fanOut, { retryLimit: 5, retryDelaySeconds: 5 });
    await bus.subscribe<AlertResolved>('AlertResolved', 'alerts-email', fanOut, { retryLimit: 5, retryDelaySeconds: 5 });

    // Last, once every queue it feeds has its worker.
    await queue.schedule(CHECK_QUEUE, CHECK_SCHEDULE);
  }
}
