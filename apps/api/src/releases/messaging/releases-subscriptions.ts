import { Logger } from '@nestjs/common';
import { BuildFailed, BuildSucceeded } from '@dreamdevops/contracts/builds/events';
import { ReleaseStarted } from '@dreamdevops/contracts/releases/events';
import { CodePushed, PullRequestMerged } from '@dreamdevops/contracts/webhooks/events';
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
    await bus.subscribe(ReleaseStarted, 'releases', ({ payload }) => this.#releases.prepare(payload.releaseId), retries);
    await bus.subscribe(
      CodePushed,
      'releases',
      ({ payload }) => this.#releases.onCodePushed({ applicationId: payload.applicationId, branch: payload.branch, after: payload.after }),
      retries,
    );
    await bus.subscribe(
      PullRequestMerged,
      'releases',
      ({ payload }) =>
        this.#releases.onPullRequestMerged({
          applicationId: payload.applicationId,
          head: payload.head,
          base: payload.base,
          mergeCommit: payload.mergeCommit,
        }),
      retries,
    );
    await bus.subscribe(BuildSucceeded, 'releases', ({ payload }) => this.#releases.onBuildFinished(payload, true), retries);
    await bus.subscribe(
      BuildFailed,
      'releases',
      ({ payload: { reason, ...build } }) => this.#releases.onBuildFinished({ ...build, ...(reason !== null && { reason }) }, false),
      retries,
    );
    // One release failing to sync doesn't stop the others, and the next sync tries it again.
    await queue.createQueue(SYNC_QUEUE, { retryLimit: 0, exclusive: true, expireInSeconds: 1_800 });
    await queue.work(SYNC_QUEUE, () => this.#releases.syncAll((error) => this.#logger.error(error)));
    await queue.schedule(SYNC_QUEUE, SYNC_SCHEDULE);
  }
}
