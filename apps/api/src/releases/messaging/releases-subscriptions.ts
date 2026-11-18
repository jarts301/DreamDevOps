import { Logger } from '@nestjs/common';
import { payloadOf } from '@dreamdevops/shared-kernel';
import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import type { Releases } from '../application/releases.ts';

/** Checks releases for merges and pushes the platform missed. */
export const SYNC_QUEUE = 'releases.sync';
/**
 * Every five minutes, in UTC. The schedule is shared by every API process, so each sync
 * runs once, wherever, and never piles up behind a slow one.
 */
export const SYNC_SCHEDULE = '*/5 * * * *';

/**
 * Prepares started releases, and moves them along as code is pushed, merged and built.
 * Every few minutes it catches up on webhooks the platform missed.
 */
export class ReleasesSubscriptions implements BackgroundSubscriber {
  readonly #logger = new Logger(ReleasesSubscriptions.name);
  readonly #releases: Releases;
  readonly #config: AppConfig;

  constructor(releases: Releases, config: AppConfig) {
    this.#releases = releases;
    this.#config = config;
  }

  async subscribe({ bus, queue }: BackgroundWork): Promise<void> {
    const retries = {
      retryLimit: this.#config.provisioningMaxAttempts + 2,
      retryDelaySeconds: this.#config.provisioningRetrySeconds,
    };
    await bus.subscribe('ReleaseStarted', 'releases', (event) => this.#releases.prepare(payloadOf(event).text('releaseId')), retries);
    await bus.subscribe(
      'CodePushed',
      'releases',
      (event) => {
        const payload = payloadOf(event);
        return this.#releases.onCodePushed({
          applicationId: payload.text('applicationId'),
          branch: payload.text('branch'),
          after: payload.text('after'),
        });
      },
      retries,
    );
    await bus.subscribe(
      'PullRequestMerged',
      'releases',
      (event) => {
        const payload = payloadOf(event);
        return this.#releases.onPullRequestMerged({
          applicationId: payload.text('applicationId'),
          head: payload.text('head'),
          base: payload.text('base'),
          mergeCommit: payload.text('mergeCommit'),
        });
      },
      retries,
    );
    for (const [eventType, succeeded] of [
      ['BuildSucceeded', true],
      ['BuildFailed', false],
    ] as const) {
      await bus.subscribe(
        eventType,
        'releases',
        (event) => {
          const payload = payloadOf(event);
          const reason = payload.optionalText('reason');
          return this.#releases.onBuildFinished(
            {
              buildId: payload.text('buildId'),
              kind: payload.text('kind'),
              commit: payload.text('commit'),
              releaseId: payload.optionalText('releaseId'),
              ...(reason !== null && { reason }),
            },
            succeeded,
          );
        },
        retries,
      );
    }
    // One release failing to sync doesn't stop the others, and the next sync tries it again.
    await queue.createQueue(SYNC_QUEUE, { retryLimit: 0, exclusive: true, expireInSeconds: 1_800 });
    await queue.work(SYNC_QUEUE, () => this.#releases.syncAll((error) => this.#logger.error(error)));
    await queue.schedule(SYNC_QUEUE, SYNC_SCHEDULE);
  }
}
