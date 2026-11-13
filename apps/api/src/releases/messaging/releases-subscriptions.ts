import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import type { FinishedBuild, Releases } from '../application/releases.ts';

/** How often releases are checked for merges and pushes the platform missed. */
const SYNC_MS = 5 * 60_000;

type Payload = Record<string, unknown>;

/**
 * Prepares started releases, and moves them along as code is pushed, merged and built.
 * Every few minutes it catches up on webhooks the platform missed.
 */
export class ReleasesSubscriptions implements BackgroundSubscriber, OnApplicationShutdown {
  readonly #logger = new Logger(ReleasesSubscriptions.name);
  readonly #releases: Releases;
  readonly #config: AppConfig;
  #sync: ReturnType<typeof setInterval> | undefined;

  constructor(releases: Releases, config: AppConfig) {
    this.#releases = releases;
    this.#config = config;
  }

  async subscribe({ bus }: BackgroundWork): Promise<void> {
    const retries = {
      retryLimit: this.#config.provisioningMaxAttempts + 2,
      retryDelaySeconds: this.#config.provisioningRetrySeconds,
    };
    const payloadOf = (event: { payload: object }) => event.payload as Payload;
    await bus.subscribe('ReleaseStarted', 'releases', (event) => this.#releases.prepare(String(payloadOf(event).releaseId)), retries);
    await bus.subscribe(
      'CodePushed',
      'releases',
      (event) => this.#releases.onCodePushed(payloadOf(event) as { applicationId: string; branch: string; after: string }),
      retries,
    );
    await bus.subscribe(
      'PullRequestMerged',
      'releases',
      (event) =>
        this.#releases.onPullRequestMerged(
          payloadOf(event) as { applicationId: string; head: string; base: string; mergeCommit: string },
        ),
      retries,
    );
    for (const [eventType, succeeded] of [
      ['BuildSucceeded', true],
      ['BuildFailed', false],
    ] as const) {
      await bus.subscribe(
        eventType,
        'releases',
        (event) => this.#releases.onBuildFinished(payloadOf(event) as unknown as FinishedBuild, succeeded),
        retries,
      );
    }
    const onError = (error: unknown) => this.#logger.error(error);
    this.#sync = setInterval(() => {
      this.#releases.syncAll(onError).catch(onError);
    }, SYNC_MS);
  }

  onApplicationShutdown(): void {
    clearInterval(this.#sync);
  }
}
