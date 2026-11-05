import { describeGitHostingContract } from './git-hosting-contract.ts';
import { InMemoryGitHosting } from './in-memory-git-hosting.ts';

const hosting = new InMemoryGitHosting();

describeGitHostingContract('in memory', () => ({
  hosting,
  addAccount: async (name) => hosting.addAccount(name),
  displayNameOf: async (name) => hosting.displayNameOf(name),
  addRepository: async (organization, repository) => hosting.addRepository(organization, repository),
  fileOf: async (organization, repository, path) => hosting.filesOf(organization, repository)?.get(path) ?? null,
  topicsOf: async (organization, repository) => hosting.topicsOf(organization, repository),
}));
