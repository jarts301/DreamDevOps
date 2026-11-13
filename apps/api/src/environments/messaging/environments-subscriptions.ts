import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import type { SecretStore } from '../application/ports.ts';
import type { TargetAgents } from '../application/target-agents.ts';
import type { TargetConfigurations } from '../application/target-configuration.ts';

/** How often targets that stopped reporting are looked for. */
const SWEEP_MS = 30_000;
/** The platform's OpenBao token is periodic: it stays valid while it's renewed. */
const RENEWAL_MS = 12 * 3_600_000;

type Payload = Record<string, unknown>;

/**
 * Removes a revoked target's deploy key, marks targets that stopped reporting as lost,
 * and keeps the platform's OpenBao token valid.
 */
export class EnvironmentsSubscriptions implements BackgroundSubscriber, OnApplicationShutdown {
  readonly #logger = new Logger(EnvironmentsSubscriptions.name);
  readonly #agents: TargetAgents;
  readonly #configurations: TargetConfigurations;
  readonly #secrets: SecretStore;
  readonly #config: AppConfig;
  #sweep: ReturnType<typeof setInterval> | undefined;
  #renewal: ReturnType<typeof setInterval> | undefined;

  constructor(agents: TargetAgents, configurations: TargetConfigurations, secrets: SecretStore, config: AppConfig) {
    this.#agents = agents;
    this.#configurations = configurations;
    this.#secrets = secrets;
    this.#config = config;
  }

  async subscribe({ bus }: BackgroundWork): Promise<void> {
    const onError = (error: unknown) => this.#logger.error(error);
    await bus.subscribe(
      'TargetRevoked',
      'target-deploy-keys',
      (event) => {
        const { environmentId, targetId, wasConnected } = event.payload as Payload;
        return wasConnected === true
          ? this.#configurations.removeDeployKey(String(environmentId), String(targetId))
          : Promise.resolve();
      },
      {
        retryLimit: this.#config.provisioningMaxAttempts + 2,
        retryDelaySeconds: this.#config.provisioningRetrySeconds,
      },
    );
    this.#sweep = setInterval(() => {
      this.#agents.markSilentTargetsLost().catch(onError);
    }, SWEEP_MS);
    await this.#secrets.renew().catch(onError);
    this.#renewal = setInterval(() => this.#secrets.renew().catch(onError), RENEWAL_MS);
  }

  onApplicationShutdown(): void {
    clearInterval(this.#sweep);
    clearInterval(this.#renewal);
  }
}
