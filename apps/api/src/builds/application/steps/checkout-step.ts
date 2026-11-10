import type { StepOutcome } from '../../domain/pipeline.ts';
import type { BuildSource } from '../ports.ts';
import type { BuildContext, PipelineStep } from './pipeline-step.ts';

/** Downloads the exact commit the build was asked for. */
export class CheckoutStep implements PipelineStep {
  readonly key = 'checkout';
  readonly #source: BuildSource;

  constructor(source: BuildSource) {
    this.#source = source;
  }

  async run(context: BuildContext): Promise<StepOutcome> {
    const { build } = context;
    context.workspace = await this.#source.checkout(context.repository, build.commit_sha);
    return {
      summary: `Checked out ${build.commit_sha.slice(0, 12)} from ${build.branch}.`,
      facts: [
        { label: 'Commit', value: build.commit_sha },
        { label: 'Branch', value: build.branch },
        ...(build.pull_request === null ? [] : [{ label: 'Pull request', value: `#${build.pull_request}` }]),
      ],
    };
  }
}
