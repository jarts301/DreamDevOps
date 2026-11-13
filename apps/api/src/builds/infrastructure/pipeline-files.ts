import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The workflows the platform keeps in each company's pipeline repository. */
export type PipelineFiles = Readonly<Record<'build.yaml' | 'check.yaml', string>>;

/**
 * Fills in a workflow: the image runner's secret label, and the test script on the
 * line where __RUN_TESTS__ stands, indented as that line is so the YAML block holds it.
 */
export function fillPipeline(workflow: string, values: { imageRunnerLabel: string; testScript: string }): string {
  const script = values.testScript.replace(/\s+$/, '').split('\n');
  const filled = workflow
    .replaceAll('__IMAGE_RUNNER_LABEL__', values.imageRunnerLabel)
    .replace(/^([ \t]*)__RUN_TESTS__[ \t]*$/gm, (_line, indent: string) =>
      script.map((line) => (line === '' ? '' : `${indent}${line}`)).join('\n'),
    );
  if (filled.includes('__RUN_TESTS__') || filled.includes('__IMAGE_RUNNER_LABEL__')) {
    throw new Error('A pipeline has a placeholder the platform could not fill in.');
  }
  return filled;
}

/** Reads the workflows and the test script from the pipelines folder, once at startup. */
export function loadPipelines(directory: string, imageRunnerLabel: string): PipelineFiles {
  const testScript = readFileSync(join(directory, 'run-tests.sh'), 'utf8');
  const read = (name: string) => fillPipeline(readFileSync(join(directory, name), 'utf8'), { imageRunnerLabel, testScript });
  return { 'build.yaml': read('build.yaml'), 'check.yaml': read('check.yaml') };
}
