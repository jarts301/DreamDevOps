import { parseCompanyId, runWithCompany } from '@dreamdevops/shared-kernel';
import type { BackgroundSubscriber, BackgroundWork } from '../../background/background-subscriber.ts';
import type { AppConfig } from '../../config/app-config.ts';
import { DEPLOY_QUEUE, type DeploymentJob, type DeploymentPipeline } from '../application/deployment-pipeline.ts';
import type { DeploymentQueued } from '../domain/events.ts';

/** A running deployment reports to the queue this often, so a crashed worker's deployment starts again soon. */
const DEPLOY_HEARTBEAT_SECONDS = 30;
/** Deployments of different environments run side by side, up to this many per API process. */
const DEPLOY_CONCURRENCY = 2;

/** Runs queued deployments. */
export class EnvironmentsSubscriptions implements BackgroundSubscriber {
  readonly #pipeline: DeploymentPipeline;
  readonly #config: AppConfig;

  constructor(pipeline: DeploymentPipeline, config: AppConfig) {
    this.#pipeline = pipeline;
    this.#config = config;
  }

  async subscribe({ bus, queue }: BackgroundWork): Promise<void> {
    // Pulling can take as long as a build's push, and becoming healthy has its own limit.
    const timeoutSeconds = Math.ceil((this.#config.buildTimeoutMs + this.#config.deployHealthTimeoutMs) / 1000);
    await queue.createQueue(DEPLOY_QUEUE, {
      retryLimit: this.#config.deployMaxAttempts + 2,
      retryDelaySeconds: this.#config.deployRetrySeconds,
      expireInSeconds: timeoutSeconds + 600,
      heartbeatSeconds: DEPLOY_HEARTBEAT_SECONDS,
    });
    await queue.work(
      DEPLOY_QUEUE,
      (job) => {
        const { companyId, deploymentId } = job.data as DeploymentJob;
        return runWithCompany(parseCompanyId(companyId), () => this.#pipeline.run(deploymentId));
      },
      { concurrency: DEPLOY_CONCURRENCY },
    );
    // The job ID is the event's, so an event delivered twice queues one run.
    await bus.subscribe<DeploymentQueued>(
      'DeploymentQueued',
      'environments-deploy',
      async (event) => {
        const job: DeploymentJob = { companyId: event.companyId, deploymentId: event.payload.deploymentId };
        await queue.send(DEPLOY_QUEUE, job, { id: event.eventId });
      },
      { retryLimit: 10, retryDelaySeconds: this.#config.deployRetrySeconds },
    );
  }
}
