import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import { PROVISIONING_TRIGGERS, type ProvisioningSaga } from '../application/provisioning.ts';

/** Brings each company's resources in line whenever the company changes. */
export class TenancySubscriptions implements BackgroundSubscriber {
  readonly #saga: ProvisioningSaga;
  readonly #config: AppConfig;

  constructor(saga: ProvisioningSaga, config: AppConfig) {
    this.#saga = saga;
    this.#config = config;
  }

  async subscribe({ bus }: BackgroundWork): Promise<void> {
    for (const eventType of PROVISIONING_TRIGGERS) {
      await bus.subscribe(eventType, 'tenancy-provisioning', () => this.#saga.reconcile(), {
        retryLimit: this.#config.provisioningMaxAttempts + 2,
        retryDelaySeconds: this.#config.provisioningRetrySeconds,
      });
    }
  }
}
