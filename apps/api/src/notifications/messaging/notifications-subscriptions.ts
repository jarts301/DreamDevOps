import { CompanyCreated, CompanyRenamed } from '@dreamdevops/contracts/tenancy/events';
import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import type { CompanyNames } from '../application/company-names.ts';
import { DELIVERY_QUEUE, type DeliveryJob, type NotificationRules } from '../application/notification-rules.ts';

/** Posts chosen events to chat tools, one delivery job per rule, and keeps company names for them. */
export class NotificationsSubscriptions implements BackgroundSubscriber {
  readonly #notifications: NotificationRules;
  readonly #names: CompanyNames;
  readonly #config: AppConfig;

  constructor(notifications: NotificationRules, names: CompanyNames, config: AppConfig) {
    this.#notifications = notifications;
    this.#names = names;
    this.#config = config;
  }

  async subscribe({ bus, queue }: BackgroundWork): Promise<void> {
    const retries = { retryLimit: 5, retryDelaySeconds: 5 };
    // Each runs in the company's context, so the name is kept for that company.
    await bus.subscribe(CompanyCreated, 'notifications-company-names', (event) => this.#names.named(event.payload.name, new Date(event.occurredAt)), retries);
    await bus.subscribe(CompanyRenamed, 'notifications-company-names', (event) => this.#names.named(event.payload.name, new Date(event.occurredAt)), retries);
    await bus.subscribeToAll('notifications', (event) => this.#notifications.fanOut(event, queue), retries);
    await queue.createQueue(DELIVERY_QUEUE, {
      retryLimit: 4,
      retryDelaySeconds: this.#config.notificationRetrySeconds,
    });
    await queue.work(DELIVERY_QUEUE, (job) => this.#notifications.deliver(job.data as DeliveryJob));
  }
}
