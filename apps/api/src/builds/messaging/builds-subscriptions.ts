import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import type { Builds } from '../application/builds.ts';

/** How often builds whose jobs died without reporting are looked for. */
const SWEEP_MS = 30_000;

type Payload = Record<string, unknown>;

/**
 * Starts requested builds, checks pull requests and reports back on them, removes feature
 * images with their branch, and fails builds whose jobs stopped reporting.
 */
export class BuildsSubscriptions implements BackgroundSubscriber, OnApplicationShutdown {
  readonly #logger = new Logger(BuildsSubscriptions.name);
  readonly #builds: Builds;
  readonly #config: AppConfig;
  #sweep: ReturnType<typeof setInterval> | undefined;

  constructor(builds: Builds, config: AppConfig) {
    this.#builds = builds;
    this.#config = config;
  }

  async subscribe({ bus }: BackgroundWork): Promise<void> {
    const retries = {
      retryLimit: this.#config.provisioningMaxAttempts + 2,
      retryDelaySeconds: this.#config.provisioningRetrySeconds,
    };
    const payloadOf = (event: { payload: object }) => event.payload as Payload;
    await bus.subscribe('BuildRequested', 'builds', (event) => this.#builds.start(String(payloadOf(event).buildId)), {
      retryLimit: 3,
      retryDelaySeconds: 10,
    });
    await bus.subscribe(
      'BranchDeleted',
      'builds-cleanup',
      async (event) => {
        const { applicationId, branch } = payloadOf(event);
        if (typeof branch === 'string' && branch.startsWith('feature/')) {
          await this.#builds.removeFeatureImages(String(applicationId), branch);
        }
      },
      retries,
    );
    await bus.subscribe(
      'PullRequestUpdated',
      'pull-request-checks',
      (event) => {
        const { applicationId, head, headCommit } = payloadOf(event);
        return this.#builds.requestCheck(String(applicationId), String(head), String(headCommit));
      },
      retries,
    );
    for (const [eventType, succeeded] of [
      ['BuildSucceeded', true],
      ['BuildFailed', false],
    ] as const) {
      await bus.subscribe(
        eventType,
        'pull-request-checks',
        (event) => {
          const { kind, applicationId, commit, reason } = payloadOf(event);
          return this.#builds.reportCheck(
            {
              kind: String(kind),
              applicationId: String(applicationId),
              commit: String(commit),
              reason: typeof reason === 'string' ? reason : undefined,
            },
            succeeded,
          );
        },
        retries,
      );
    }
    // Builds whose jobs died without reporting are failed once they pass the timeout.
    this.#sweep = setInterval(() => {
      this.#builds.expireStale().catch((error: unknown) => this.#logger.error(error));
    }, SWEEP_MS);
  }

  onApplicationShutdown(): void {
    clearInterval(this.#sweep);
  }
}
