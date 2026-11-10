import { TenantDatabase } from '@dreamdevops/shared-kernel/postgres';
import type { StepOutcome } from '../../domain/pipeline.ts';
import type { ImageBuilder, ImageRegistry } from '../ports.ts';
import type { BuildContext, PipelineStep } from './pipeline-step.ts';

/** Pushes the image to the registry, and records its digest. */
export class PublishStep implements PipelineStep {
  readonly key = 'publish';
  readonly #builder: ImageBuilder;
  readonly #registry: ImageRegistry;
  readonly #database: TenantDatabase;

  constructor(builder: ImageBuilder, registry: ImageRegistry, database: TenantDatabase) {
    this.#builder = builder;
    this.#registry = registry;
    this.#database = database;
  }

  async run(context: BuildContext): Promise<StepOutcome> {
    await this.#builder.push(context.localImage, context.image);
    const digest = await this.#registry.digest(context.imageRepository, context.build.version);
    context.digest = digest;
    await this.#database.transaction((tx) =>
      tx.query('UPDATE builds.builds SET image = $2, digest = $3, updated_at = now() WHERE id = $1', [
        context.build.id,
        context.image,
        digest,
      ]),
    );
    return {
      summary: `Published ${context.image}.`,
      facts: [
        { label: 'Image', value: context.image },
        { label: 'Digest', value: digest },
      ],
    };
  }
}
