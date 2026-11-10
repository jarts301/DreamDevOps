import { describeError } from '@dreamdevops/shared-kernel';
import { INTEGRATION_BRANCH, isFeatureBranch } from '../domain/branches.ts';
import { BuildError } from '../domain/errors.ts';
import type { BuildSource, PullRequest, RepositoryRef } from './ports.ts';

/** Calls the Git tool while answering a request, so an outage gives people a clear message. */
export async function callGit<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BuildError) {
      throw error;
    }
    throw new BuildError('unavailable', error instanceof Error ? describeError(error) : 'The Git service failed.');
  }
}

/** Whether a branch exists. When the Git tool can't say, it's assumed to, so nothing looks finished that isn't. */
export async function branchExists(source: BuildSource, repository: RepositoryRef, branch: string): Promise<boolean> {
  try {
    return (await source.branch(repository, branch)) !== null;
  } catch {
    return true;
  }
}

/** Why a pull request can't have a development image, or null if it can. */
export function developmentProblem(pullRequest: PullRequest, repository: RepositoryRef): string | null {
  if (pullRequest.state !== 'open') {
    return `Pull request #${pullRequest.number} is closed.`;
  }
  if (!isFeatureBranch(pullRequest.head.branch)) {
    return 'Development images are built from feature branches, such as feature/login.';
  }
  if (pullRequest.base.branch !== INTEGRATION_BRANCH) {
    return `The pull request must target ${INTEGRATION_BRANCH}.`;
  }
  // A fork's code could come from anyone, so only the application's own repository is built.
  if (pullRequest.head.repository !== `${repository.organization}/${repository.name}`) {
    return "The pull request's branch must be in the application's own repository.";
  }
  return null;
}
