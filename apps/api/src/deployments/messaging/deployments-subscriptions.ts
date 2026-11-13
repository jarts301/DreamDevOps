import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import type { Deployments } from '../application/deployments.ts';

/** How often rollouts that stopped moving are looked for. */
const SWEEP_MS = 30_000;

/**
 * Writes queued deployments to their environment's repository, goes back to the last
 * version that ran well after a failed or aborted one, and fails stalled rollouts.
 */
export class DeploymentsSubscriptions implements BackgroundSubscriber, OnApplicationShutdown {
  readonly #logger = new Logger(DeploymentsSubscriptions.name);
  readonly #deployments: Deployments;
  readonly #config: AppConfig;
  #sweep: ReturnType<typeof setInterval> | undefined;

  constructor(deployments: Deployments, config: AppConfig) {
    this.#deployments = deployments;
    this.#config = config;
  }

  async subscribe({ bus }: BackgroundWork): Promise<void> {
    const retries = {
      retryLimit: this.#config.provisioningMaxAttempts + 2,
      retryDelaySeconds: this.#config.provisioningRetrySeconds,
    };
    const deploymentOf = (event: { payload: object }) => String((event.payload as { deploymentId?: unknown }).deploymentId);
    await bus.subscribe('DeploymentQueued', 'deployments', (event) => this.#deployments.commit(deploymentOf(event)), retries);
    for (const eventType of ['DeploymentFailed', 'DeploymentAborted']) {
      // Git goes back to the last version that ran well, so Flux keeps running it.
      await bus.subscribe(eventType, 'deployment-restores', (event) => this.#deployments.restorePrevious(deploymentOf(event)), retries);
    }
    this.#sweep = setInterval(() => {
      this.#deployments.failStalled().catch((error: unknown) => this.#logger.error(error));
    }, SWEEP_MS);
  }

  onApplicationShutdown(): void {
    clearInterval(this.#sweep);
  }
}
