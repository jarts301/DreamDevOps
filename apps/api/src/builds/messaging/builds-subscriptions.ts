import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import type { RepositoryCreated } from '../../source-governance/domain/events.ts';
import { BUILD_QUEUE, type BuildJob, type BuildPipeline } from '../application/build-pipeline.ts';
import type { Builds } from '../application/builds.ts';

/** A running build reports to the queue this often, so a crashed worker's build starts again soon. */
const BUILD_HEARTBEAT_SECONDS = 30;
/** The most a queue allows a job to run. */
const MAX_JOB_SECONDS = 24 * 60 * 60;

/** Sets up webhooks for new repositories, and runs queued builds. */
export class BuildsSubscriptions implements BackgroundSubscriber {
  readonly #builds: Builds;
  readonly #pipeline: BuildPipeline;
  readonly #config: AppConfig;

  constructor(builds: Builds, pipeline: BuildPipeline, config: AppConfig) {
    this.#builds = builds;
    this.#pipeline = pipeline;
    this.#config = config;
  }

  async subscribe({ bus, queue }: BackgroundWork): Promise<void> {
    const retries = {
      retryLimit: this.#config.provisioningMaxAttempts + 2,
      retryDelaySeconds: this.#config.provisioningRetrySeconds,
    };
    // New repositories get the webhook that reports new branches and merges.
    await bus.subscribe<RepositoryCreated>(
      'RepositoryCreated',
      'builds-webhooks',
      (event) => this.#builds.ensureWebhook(event.payload.applicationId),
      retries,
    );
    // Builds take minutes, so each runs as its own long job with a heartbeat. The job ID is
    // the event's, so an event delivered twice queues one run.
    const buildTimeoutSeconds = Math.ceil(this.#config.buildTimeoutMs / 1000);
    await queue.createQueue(BUILD_QUEUE, {
      retryLimit: this.#config.buildMaxAttempts + 2,
      retryDelaySeconds: this.#config.buildRetrySeconds,
      // Building, scanning and publishing can each take up to the timeout.
      expireInSeconds: Math.min(MAX_JOB_SECONDS, buildTimeoutSeconds * 3 + 600),
      heartbeatSeconds: BUILD_HEARTBEAT_SECONDS,
    });
    await queue.work(
      BUILD_QUEUE,
      (job) => {
        const { companyId, buildId } = job.data as BuildJob;
        return runWithCompany(parseCompanyId(companyId), () => this.#pipeline.run(buildId));
      },
      { concurrency: this.#config.buildConcurrency },
    );
    await bus.subscribe(
      'BuildQueued',
      'builds-dispatch',
      async (event) => {
        const job: BuildJob = { companyId: event.companyId, buildId: (event.payload as { buildId: string }).buildId };
        await queue.send(BUILD_QUEUE, job, { id: event.eventId });
      },
      retries,
    );
  }
}
