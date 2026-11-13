/**
 * A blueprint's pipeline, as its workflow file says: the container image it runs in, and
 * the command of each step, in order. Steps that use an action, such as checking out the
 * code, are left out, as the code is already there where the pipeline runs in tests.
 */
export function pipelineOf(workflow: string): { image: string; steps: string[] } {
  const image = /^\s+container:\s*\n\s+image:\s*(\S+)\s*$/m.exec(workflow)?.[1];
  const steps = [...workflow.matchAll(/^\s+- run: (.+)$/gm)].map((match) => match[1]!);
  if (image === undefined || steps.length === 0) {
    throw new Error('The pipeline names no container image or runs nothing.');
  }
  return { image, steps };
}
