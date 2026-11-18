import { payloadOf } from '@dreamdevops/shared-kernel';
import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import type { Builds } from '../application/builds.ts';

/** Fails builds whose jobs died without reporting, once they pass the timeout. */
export const EXPIRE_QUEUE = 'builds.expire-stale';
/**
 * Every minute, in UTC. The schedule is shared by every API process, so each minute's
 * sweep runs once, wherever, and never piles up behind a slow one.
 */
export const EXPIRE_SCHEDULE = '* * * * *';

/**
 * Starts requested builds, checks pull requests and reports back on them, removes feature
 * images with their branch, and fails builds whose jobs stopped reporting.
 */
export class BuildsSubscriptions implements BackgroundSubscriber {
  readonly #builds: Builds;
  readonly #config: AppConfig;

  constructor(builds: Builds, config: AppConfig) {
    this.#builds = builds;
    this.#config = config;
  }

  async subscribe({ bus, queue }: BackgroundWork): Promise<void> {
    const retries = {
      retryLimit: this.#config.provisioningMaxAttempts + 2,
      retryDelaySeconds: this.#config.provisioningRetrySeconds,
    };
    await bus.subscribe('BuildRequested', 'builds', (event) => this.#builds.start(payloadOf(event).text('buildId')), {
      retryLimit: 3,
      retryDelaySeconds: 10,
    });
    await bus.subscribe(
      'BranchDeleted',
      'builds-cleanup',
      async (event) => {
        const payload = payloadOf(event);
        const branch = payload.text('branch');
        if (branch.startsWith('feature/')) {
          await this.#builds.removeFeatureImages(payload.text('applicationId'), branch);
        }
      },
      retries,
    );
    await bus.subscribe(
      'PullRequestUpdated',
      'pull-request-checks',
      (event) => {
        const payload = payloadOf(event);
        return this.#builds.requestCheck(payload.text('applicationId'), payload.text('head'), payload.text('headCommit'));
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
          const payload = payloadOf(event);
          const reason = payload.optionalText('reason');
          return this.#builds.reportCheck(
            {
              kind: payload.text('kind'),
              applicationId: payload.text('applicationId'),
              commit: payload.text('commit'),
              reason: reason ?? undefined,
            },
            succeeded,
          );
        },
        retries,
      );
    }
    await queue.createQueue(EXPIRE_QUEUE, { retryLimit: 0, exclusive: true, expireInSeconds: 600 });
    await queue.work(EXPIRE_QUEUE, () => this.#builds.expireStale());
    await queue.schedule(EXPIRE_QUEUE, EXPIRE_SCHEDULE);
  }
}
