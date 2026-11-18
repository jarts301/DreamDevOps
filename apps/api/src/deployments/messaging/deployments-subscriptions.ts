import { DeploymentAborted, DeploymentFailed, DeploymentQueued } from '@dreamdevops/contracts/deployments/events';
import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import type { Deployments } from '../application/deployments.ts';

/** Fails rollouts that stopped moving. */
export const STALLED_QUEUE = 'deployments.fail-stalled';
/**
 * Every minute, in UTC. The schedule is shared by every API process, so each minute's
 * sweep runs once, wherever, and never piles up behind a slow one.
 */
export const STALLED_SCHEDULE = '* * * * *';

/**
 * Writes queued deployments to their environment's repository, goes back to the last
 * version that ran well after a failed or aborted one, and fails stalled rollouts.
 */
export class DeploymentsSubscriptions implements BackgroundSubscriber {
  readonly #deployments: Deployments;
  readonly #config: AppConfig;

  constructor(deployments: Deployments, config: AppConfig) {
    this.#deployments = deployments;
    this.#config = config;
  }

  async subscribe({ bus, queue }: BackgroundWork): Promise<void> {
    const retries = {
      retryLimit: this.#config.provisioningMaxAttempts + 2,
      retryDelaySeconds: this.#config.provisioningRetrySeconds,
    };
    await bus.subscribe(DeploymentQueued, 'deployments', ({ payload }) => this.#deployments.commit(payload.deploymentId), retries);
    // Git goes back to the last version that ran well, so Flux keeps running it.
    await bus.subscribe(DeploymentFailed, 'deployment-restores', ({ payload }) => this.#deployments.restorePrevious(payload.deploymentId), retries);
    await bus.subscribe(DeploymentAborted, 'deployment-restores', ({ payload }) => this.#deployments.restorePrevious(payload.deploymentId), retries);
    await queue.createQueue(STALLED_QUEUE, { retryLimit: 0, exclusive: true, expireInSeconds: 600 });
    await queue.work(STALLED_QUEUE, () => this.#deployments.failStalled());
    await queue.schedule(STALLED_QUEUE, STALLED_SCHEDULE);
  }
}
