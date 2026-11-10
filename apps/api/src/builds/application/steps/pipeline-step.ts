import type { ApplicationView } from '../../../catalog/application/application-catalog.ts';
import type { StepKey, StepOutcome } from '../../domain/pipeline.ts';
import type { BuildRow } from '../build-records.ts';
import type { RepositoryRef, Workspace } from '../ports.ts';

/** What the steps of one build share, and pass on to the steps after them. */
export interface BuildContext {
  readonly build: BuildRow;
  readonly application: ApplicationView;
  readonly repository: RepositoryRef;
  /** Where the image is published, such as localhost:3000/acme/billing. */
  readonly imageRepository: string;
  /** Its published name, with the version as its tag. */
  readonly image: string;
  /** Its name on this machine while it's built and checked. */
  readonly localImage: string;
  /** Set by the checkout step. */
  workspace: Workspace | null;
  /** Set by the publish step. */
  digest: string | null;
}

/**
 * One step of the build pipeline. A step reports failed checks in its outcome, which
 * stops the build for good. It throws a PermanentBuildError when retrying can't help,
 * and any other error when it might.
 */
export interface PipelineStep {
  readonly key: StepKey;
  run(context: BuildContext): Promise<StepOutcome>;
}
