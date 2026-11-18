import { Logger } from '@nestjs/common';
import { payloadOf } from '@dreamdevops/shared-kernel';
import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import type { SecretStore } from '../application/ports.ts';
import type { TargetAgents } from '../application/target-agents.ts';
import type { TargetConfigurations } from '../application/target-configuration.ts';

/** Marks targets that stopped reporting as lost. */
export const LOST_TARGETS_QUEUE = 'environments.mark-lost-targets';
/**
 * Every minute, in UTC. The schedule is shared by every API process, so each minute's
 * sweep runs once, wherever, and never piles up behind a slow one.
 */
export const LOST_TARGETS_SCHEDULE = '* * * * *';
/** Renews the platform's OpenBao token, which is periodic: it stays valid while it's renewed. */
export const RENEWAL_QUEUE = 'environments.renew-secrets-token';
/** Every six hours, in UTC, well within the token's period. */
export const RENEWAL_SCHEDULE = '0 */6 * * *';

/**
 * Removes a revoked target's deploy key, marks targets that stopped reporting as lost,
 * and keeps the platform's OpenBao token valid.
 */
export class EnvironmentsSubscriptions implements BackgroundSubscriber {
  readonly #logger = new Logger(EnvironmentsSubscriptions.name);
  readonly #agents: TargetAgents;
  readonly #configurations: TargetConfigurations;
  readonly #secrets: SecretStore;
  readonly #config: AppConfig;

  constructor(agents: TargetAgents, configurations: TargetConfigurations, secrets: SecretStore, config: AppConfig) {
    this.#agents = agents;
    this.#configurations = configurations;
    this.#secrets = secrets;
    this.#config = config;
  }

  async subscribe({ bus, queue }: BackgroundWork): Promise<void> {
    await bus.subscribe(
      'TargetRevoked',
      'target-deploy-keys',
      (event) => {
        const payload = payloadOf(event);
        // This machine has no agent, so it has no deploy key.
        return payload.optionalFlag('wasConnected') && payload.optionalText('provider') !== 'local'
          ? this.#configurations.removeDeployKey(payload.text('environmentId'), payload.text('targetId'))
          : Promise.resolve();
      },
      {
        retryLimit: this.#config.provisioningMaxAttempts + 2,
        retryDelaySeconds: this.#config.provisioningRetrySeconds,
      },
    );
    await queue.createQueue(LOST_TARGETS_QUEUE, { retryLimit: 0, exclusive: true, expireInSeconds: 600 });
    await queue.work(LOST_TARGETS_QUEUE, () => this.#agents.markSilentTargetsLost());
    await queue.schedule(LOST_TARGETS_QUEUE, LOST_TARGETS_SCHEDULE);

    // Renewed at every start as well, in case the API was down for longer than the schedule's gap.
    await this.#secrets.renew().catch((error: unknown) => this.#logger.error(error));
    await queue.createQueue(RENEWAL_QUEUE, { retryLimit: 3, retryDelaySeconds: 60, exclusive: true });
    await queue.work(RENEWAL_QUEUE, () => this.#secrets.renew());
    await queue.schedule(RENEWAL_QUEUE, RENEWAL_SCHEDULE);
  }
}
