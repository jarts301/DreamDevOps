import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import type { FinishedBuild, Releases } from '../application/releases.ts';

type Payload = Record<string, unknown>;

/** Prepares started releases, and moves them along as code is pushed, merged and built. */
export class ReleasesSubscriptions implements BackgroundSubscriber {
  readonly #releases: Releases;
  readonly #config: AppConfig;

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
  }
}
