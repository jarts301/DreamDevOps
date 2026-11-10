import type { StepOutcome } from '../../domain/pipeline.ts';
import type { BuildSource } from '../ports.ts';
import type { BuildContext, PipelineStep } from './pipeline-step.ts';

/** Tags a release's merge commit in Git. */
export class TagStep implements PipelineStep {
  readonly key = 'tag';
  readonly #source: BuildSource;

  constructor(source: BuildSource) {
    this.#source = source;
  }

  async run(context: BuildContext): Promise<StepOutcome> {
    const name = `v${context.build.version}`;
    await this.#source.createTag(context.repository, {
      name,
      commit: context.build.commit_sha,
      message: `Release ${context.build.version}, built and signed by DreamDevOps as ${context.image}@${context.digest}`,
    });
    return { summary: `Tagged ${context.build.commit_sha.slice(0, 12)} as ${name}.`, facts: [{ label: 'Tag', value: name }] };
  }
}
