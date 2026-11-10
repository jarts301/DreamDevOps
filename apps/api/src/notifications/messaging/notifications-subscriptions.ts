import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import { DELIVERY_QUEUE, type DeliveryJob, type NotificationRules } from '../application/notification-rules.ts';

/** Posts chosen events to chat tools, one delivery job per rule. */
export class NotificationsSubscriptions implements BackgroundSubscriber {
  readonly #notifications: NotificationRules;
  readonly #config: AppConfig;

  constructor(notifications: NotificationRules, config: AppConfig) {
    this.#notifications = notifications;
    this.#config = config;
  }

  async subscribe({ bus, queue }: BackgroundWork): Promise<void> {
    await bus.subscribeToAll('notifications', (event) => this.#notifications.fanOut(event, queue), {
      retryLimit: 5,
      retryDelaySeconds: 5,
    });
    await queue.createQueue(DELIVERY_QUEUE, {
      retryLimit: 4,
      retryDelaySeconds: this.#config.notificationRetrySeconds,
    });
    await queue.work(DELIVERY_QUEUE, (job) => this.#notifications.deliver(job.data as DeliveryJob));
  }
}
