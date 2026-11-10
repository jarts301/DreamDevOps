import type { StepOutcome } from '../../domain/pipeline.ts';
import type { SigningKey } from '../../domain/signature.ts';
import type { ImageRegistry } from '../ports.ts';
import { checkSignature } from '../signature-check.ts';
import type { BuildContext, PipelineStep } from './pipeline-step.ts';

/** Reads the signature back from the registry, and checks it. */
export class VerifyStep implements PipelineStep {
  readonly key = 'verify';
  readonly #registry: ImageRegistry;
  readonly #key: SigningKey;

  constructor(registry: ImageRegistry, key: SigningKey) {
    this.#registry = registry;
    this.#key = key;
  }

  async run(context: BuildContext): Promise<StepOutcome> {
    const digest = context.digest!;
    const { valid, checks } = await checkSignature(this.#registry, this.#key, { repository: context.imageRepository, digest });
    return {
      summary: valid ? 'The published signature checks out.' : "The published signature doesn't check out.",
      checks,
      facts: [
        {
          label: 'Check it yourself',
          value: `cosign verify --key dreamdevops-images.pub --insecure-ignore-tlog=true ${context.imageRepository}@${digest}`,
        },
      ],
    };
  }
}
