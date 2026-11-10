import type { StepOutcome } from '../../domain/pipeline.ts';
import { SIGNING_ALGORITHM, type SigningKey, signaturePayload } from '../../domain/signature.ts';
import type { ImageRegistry } from '../ports.ts';
import type { BuildContext, PipelineStep } from './pipeline-step.ts';

/** Signs the image's digest with the platform's key, and stores the signature beside it. */
export class SignStep implements PipelineStep {
  readonly key = 'sign';
  readonly #registry: ImageRegistry;
  readonly #key: SigningKey;

  constructor(registry: ImageRegistry, key: SigningKey) {
    this.#registry = registry;
    this.#key = key;
  }

  async run(context: BuildContext): Promise<StepOutcome> {
    const digest = context.digest!;
    const payload = signaturePayload(context.imageRepository, digest);
    const tag = await this.#registry.attachSignature(context.imageRepository, digest, {
      payload,
      signature: this.#key.sign(payload),
    });
    return {
      summary: "Signed with the platform's key.",
      facts: [
        { label: 'Algorithm', value: SIGNING_ALGORITHM },
        { label: 'Key fingerprint', value: this.#key.fingerprint },
        { label: 'Signature', value: `${context.imageRepository}:${tag}` },
      ],
    };
  }
}
