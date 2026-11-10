import type { StepOutcome } from '../../domain/pipeline.ts';
import type { ImageBuilder } from '../ports.ts';
import type { BuildContext, PipelineStep } from './pipeline-step.ts';

/** Builds the image from the Dockerfile, labelled with its version, commit and source. */
export class BuildImageStep implements PipelineStep {
  readonly key = 'build';
  readonly #builder: ImageBuilder;
  readonly #sourceUrl: string;

  constructor(builder: ImageBuilder, sourceUrl: string) {
    this.#builder = builder;
    this.#sourceUrl = sourceUrl;
  }

  async run(context: BuildContext): Promise<StepOutcome> {
    const { build, application, repository } = context;
    await this.#builder.build({
      directory: context.workspace!.directory,
      image: context.localImage,
      labels: {
        'org.opencontainers.image.title': application.name,
        'org.opencontainers.image.version': build.version,
        'org.opencontainers.image.revision': build.commit_sha,
        'org.opencontainers.image.source': `${this.#sourceUrl.replace(/\/$/, '')}/${repository.organization}/${repository.name}`,
        'org.opencontainers.image.created': new Date().toISOString(),
        'dev.dreamdevops.build.id': build.id,
        'dev.dreamdevops.build.kind': build.kind,
      },
    });
    return {
      summary: 'Built from the Dockerfile at the top of the repository.',
      facts: [{ label: 'Version label', value: build.version }],
    };
  }
}
