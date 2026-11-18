import { BuildFailed, BuildRequested, BuildSucceeded } from '@dreamdevops/contracts/builds/events';
import { BranchDeleted, PullRequestUpdated } from '@dreamdevops/contracts/webhooks/events';
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
    await bus.subscribe(BuildRequested, 'builds', (event) => this.#builds.start(event.payload.buildId), {
      retryLimit: 3,
      retryDelaySeconds: 10,
    });
    await bus.subscribe(
      BranchDeleted,
      'builds-cleanup',
      async ({ payload }) => {
        if (payload.branch.startsWith('feature/')) {
          await this.#builds.removeFeatureImages(payload.applicationId, payload.branch);
        }
      },
      retries,
    );
    await bus.subscribe(
      PullRequestUpdated,
      'pull-request-checks',
      ({ payload }) => this.#builds.requestCheck(payload.applicationId, payload.head, payload.headCommit),
      retries,
    );
    await bus.subscribe(
      BuildSucceeded,
      'pull-request-checks',
      ({ payload }) => this.#builds.reportCheck({ kind: payload.kind, applicationId: payload.applicationId, commit: payload.commit }, true),
      retries,
    );
    await bus.subscribe(
      BuildFailed,
      'pull-request-checks',
      ({ payload }) =>
        this.#builds.reportCheck(
          { kind: payload.kind, applicationId: payload.applicationId, commit: payload.commit, reason: payload.reason ?? undefined },
          false,
        ),
      retries,
    );
    await queue.createQueue(EXPIRE_QUEUE, { retryLimit: 0, exclusive: true, expireInSeconds: 600 });
    await queue.work(EXPIRE_QUEUE, () => this.#builds.expireStale());
    await queue.schedule(EXPIRE_QUEUE, EXPIRE_SCHEDULE);
  }
}
