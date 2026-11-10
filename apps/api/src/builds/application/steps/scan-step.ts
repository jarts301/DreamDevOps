import { failed, passed, type StepOutcome, warning } from '../../domain/pipeline.ts';
import { type ImageScanner, SEVERITIES } from '../ports.ts';
import type { BuildContext, PipelineStep } from './pipeline-step.ts';

/** Scans the image for known vulnerabilities. Critical ones stop the build. */
export class ScanStep implements PipelineStep {
  readonly key = 'scan';
  readonly #scanner: ImageScanner;

  constructor(scanner: ImageScanner) {
    this.#scanner = scanner;
  }

  async run(context: BuildContext): Promise<StepOutcome> {
    if (this.#scanner.name === null) {
      return { skipped: true, summary: 'Vulnerability scanning is turned off on this server.' };
    }
    const report = await this.#scanner.scan(context.localImage);
    const list = (severity: string) =>
      report.findings
        .filter((finding) => finding.severity === severity)
        .slice(0, 5)
        .map(
          (finding) =>
            `${finding.id} in ${finding.packageName} ${finding.installedVersion}${finding.fixedVersion === null ? '' : ` (fixed in ${finding.fixedVersion})`}`,
        )
        .join('; ');
    const { critical, high } = report.counts;
    return {
      summary:
        critical > 0
          ? `Found ${critical} critical vulnerabilit${critical === 1 ? 'y' : 'ies'}.`
          : `No critical vulnerabilities, checked with ${this.#scanner.name}.`,
      checks: [
        critical === 0
          ? passed('No critical vulnerabilities')
          : failed('No critical vulnerabilities', `${critical} found: ${list('critical')}. Update the affected packages or base image.`),
        high === 0
          ? passed('No high vulnerabilities')
          : warning('No high vulnerabilities', `${high} found: ${list('high')}. Review them before releasing.`),
      ],
      facts: [
        ...SEVERITIES.map((severity) => ({
          label: severity[0]!.toUpperCase() + severity.slice(1),
          value: String(report.counts[severity]),
        })),
        { label: 'Scanner', value: this.#scanner.name },
      ],
    };
  }
}
