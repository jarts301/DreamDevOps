import type {
  EnvironmentGitOps,
  EnvironmentRepository,
  FileChange,
} from '@dreamdevops/contracts/environments/services';
import type { EnvironmentRepositories } from './ports.ts';
import type { TargetConfigurations } from './target-configuration.ts';

/**
 * What Deployments writes to an environment's repository, which its target's Flux applies.
 * The repository, and the Git tool it lives in, stay this context's business.
 */
export class EnvironmentGitOpsService implements EnvironmentGitOps {
  readonly #configurations: TargetConfigurations;
  readonly #repositories: EnvironmentRepositories;

  constructor(configurations: TargetConfigurations, repositories: EnvironmentRepositories) {
    this.#configurations = configurations;
    this.#repositories = repositories;
  }

  repositoryOf(environmentId: string): Promise<EnvironmentRepository> {
    return this.#configurations.repositoryOf(environmentId);
  }

  readFolder(repository: EnvironmentRepository, folder: string): Promise<Map<string, string>> {
    return this.#repositories.readFolder(repository, folder);
  }

  commit(repository: EnvironmentRepository, message: string, changes: readonly FileChange[]): Promise<string> {
    return this.#repositories.commit(repository, message, changes);
  }
}
