import { failed, passed, type StepOutcome } from '../../domain/pipeline.ts';
import type { ImageBuilder } from '../ports.ts';
import type { BuildContext, PipelineStep } from './pipeline-step.ts';

/** Checks the built image's settings against the platform's rules. */
export class InspectStep implements PipelineStep {
  readonly key = 'inspect';
  readonly #builder: ImageBuilder;

  constructor(builder: ImageBuilder) {
    this.#builder = builder;
  }

  async run(context: BuildContext): Promise<StepOutcome> {
    const details = await this.#builder.inspect(context.localImage);
    const user = details.user.split(':')[0] ?? '';
    const root = user === '' || user === 'root' || user === '0';
    return {
      summary: root || !details.healthcheck ? 'The image breaks a platform rule.' : 'The image follows the platform rules.',
      checks: [
        root
          ? failed('It runs as a non-root user', 'The image runs as root. Add a USER instruction with a non-root user.')
          : passed('It runs as a non-root user', `It runs as "${details.user}".`),
        details.healthcheck
          ? passed('It has a health check')
          : failed('It has a health check', 'Add a HEALTHCHECK instruction, so deployments can tell when it is ready.'),
      ],
      facts: [
        { label: 'Size', value: `${(details.sizeBytes / 1_000_000).toFixed(1)} MB` },
        ...(details.exposedPorts.length === 0 ? [] : [{ label: 'Ports', value: details.exposedPorts.join(', ') }]),
      ],
    };
  }
}
