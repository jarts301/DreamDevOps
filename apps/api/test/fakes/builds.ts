import { createHash } from 'node:crypto';
import {
  type BuildSource,
  type ImageBuilder,
  type ImageDetails,
  type ImageRegistry,
  type ImageScanner,
  PermanentBuildError,
  type PullRequest,
  type RepositoryRef,
  type ScanReport,
  type StoredSignature,
  type Workspace,
} from '../../src/builds/application/ports.ts';

/** A Dockerfile that follows every platform rule. */
export const GOOD_DOCKERFILE = [
  'FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8',
  'WORKDIR /app',
  'COPY . .',
  'USER node',
  'HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/health/live || exit 1',
  'CMD ["node", "main.js"]',
].join('\n');

let commitCounter = 0;
/** A new, unique commit ID. */
export const newCommit = (): string => {
  commitCounter += 1;
  return createHash('sha1').update(`commit-${commitCounter}-${Math.random()}`).digest('hex');
};

interface FakeGitRepository {
  readonly branches: Map<string, string>;
  readonly pullRequests: Map<number, PullRequest>;
  readonly tags: Map<string, string>;
  readonly hooks: { url: string; secret: string }[];
  /** Files at every commit, unless a commit has its own. */
  files: Record<string, string>;
  readonly filesAt: Map<string, Record<string, string>>;
}

/** Keeps branches, pull requests and tags in memory, like the Git tool would. */
export class FakeBuildSource implements BuildSource {
  readonly repositories = new Map<string, FakeGitRepository>();
  /** Errors to throw, one per call, before calls start succeeding. */
  readonly failures: Error[] = [];
  readonly disposed: string[] = [];

  /** The repository's state, created with main and develop on first use. */
  repository(organization: string, name: string): FakeGitRepository {
    const key = `${organization}/${name}`;
    let repository = this.repositories.get(key);
    if (repository === undefined) {
      const initial = newCommit();
      repository = {
        branches: new Map([
          ['main', initial],
          ['develop', initial],
        ]),
        pullRequests: new Map(),
        tags: new Map(),
        hooks: [],
        files: { Dockerfile: GOOD_DOCKERFILE, '.dockerignore': 'node_modules\n' },
        filesAt: new Map(),
      };
      this.repositories.set(key, repository);
    }
    return repository;
  }

  /** Pushes a new commit to a branch, and returns it. */
  push(organization: string, name: string, branch: string): string {
    const commit = newCommit();
    this.repository(organization, name).branches.set(branch, commit);
    return commit;
  }

  openPullRequest(
    organization: string,
    name: string,
    pull: { number: number; branch: string; base?: string; fork?: boolean },
  ): PullRequest {
    const repository = this.repository(organization, name);
    const commit = repository.branches.get(pull.branch) ?? this.push(organization, name, pull.branch);
    const pullRequest: PullRequest = {
      number: pull.number,
      title: `Change from ${pull.branch}`,
      state: 'open',
      merged: false,
      mergeCommit: null,
      head: { branch: pull.branch, commit, repository: pull.fork ? `someone/${name}` : `${organization}/${name}` },
      base: { branch: pull.base ?? 'develop' },
      url: `http://git.test/${organization}/${name}/pulls/${pull.number}`,
      author: 'someone',
    };
    repository.pullRequests.set(pull.number, pullRequest);
    return pullRequest;
  }

  /** Merges a pull request, moving its target branch to a new merge commit. */
  merge(organization: string, name: string, number: number): PullRequest {
    const repository = this.repository(organization, name);
    const open = repository.pullRequests.get(number)!;
    const mergeCommit = newCommit();
    const merged: PullRequest = { ...open, state: 'closed', merged: true, mergeCommit };
    repository.pullRequests.set(number, merged);
    repository.branches.set(open.base.branch, mergeCommit);
    return merged;
  }

  #fail(): void {
    const failure = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
  }

  async ensureWebhook(repository: RepositoryRef, hook: { url: string; secret: string }): Promise<void> {
    this.#fail();
    const hooks = this.repository(repository.organization, repository.name).hooks;
    const existing = hooks.findIndex((candidate) => candidate.url === hook.url);
    if (existing === -1) {
      hooks.push({ ...hook });
    } else {
      hooks[existing] = { ...hook };
    }
  }

  async branch(repository: RepositoryRef, name: string): Promise<{ name: string; commit: string } | null> {
    this.#fail();
    const commit = this.repository(repository.organization, repository.name).branches.get(name);
    return commit === undefined ? null : { name, commit };
  }

  async createBranch(repository: RepositoryRef, name: string, from: string): Promise<{ name: string; commit: string }> {
    this.#fail();
    const branches = this.repository(repository.organization, repository.name).branches;
    if (!branches.has(name)) {
      branches.set(name, branches.get(from)!);
    }
    return { name, commit: branches.get(name)! };
  }

  async pullRequest(repository: RepositoryRef, number: number): Promise<PullRequest | null> {
    this.#fail();
    return this.repository(repository.organization, repository.name).pullRequests.get(number) ?? null;
  }

  async pullRequests(repository: RepositoryRef, state: 'open' | 'closed'): Promise<PullRequest[]> {
    this.#fail();
    return [...this.repository(repository.organization, repository.name).pullRequests.values()].filter(
      (pullRequest) => pullRequest.state === state,
    );
  }

  async checkout(repository: RepositoryRef, commit: string): Promise<Workspace> {
    this.#fail();
    const state = this.repository(repository.organization, repository.name);
    const files = state.filesAt.get(commit) ?? state.files;
    const directory = `/fake/${repository.organization}/${repository.name}/${commit}`;
    return {
      directory,
      readFile: async (path) => files[path] ?? null,
      dispose: async () => {
        this.disposed.push(directory);
      },
    };
  }

  async createTag(repository: RepositoryRef, tag: { name: string; commit: string; message: string }): Promise<void> {
    this.#fail();
    const tags = this.repository(repository.organization, repository.name).tags;
    const existing = tags.get(tag.name);
    if (existing !== undefined && existing !== tag.commit) {
      throw new PermanentBuildError(`The tag ${tag.name} already exists on another commit.`);
    }
    tags.set(tag.name, tag.commit);
  }
}

/** An image registry in memory, with tags and cosign signatures. */
export class FakeImageRegistry implements ImageRegistry {
  readonly host = 'registry.test';
  readonly tags = new Map<string, string>();
  readonly stored = new Map<string, StoredSignature[]>();

  async digest(repository: string, tag: string): Promise<string> {
    const digest = this.tags.get(`${repository}:${tag}`);
    if (digest === undefined) {
      throw new Error(`The registry has no ${repository}:${tag}.`);
    }
    return digest;
  }

  async attachSignature(repository: string, digest: string, signature: StoredSignature): Promise<string> {
    const key = `${repository}@${digest}`;
    this.stored.set(key, [...(this.stored.get(key) ?? []), signature]);
    return `${digest.replace(':', '-')}.sig`;
  }

  async signatures(repository: string, digest: string): Promise<StoredSignature[]> {
    return this.stored.get(`${repository}@${digest}`) ?? [];
  }
}

/** Pretends to build and push images, and can be told what the built image looks like. */
export class FakeImageBuilder implements ImageBuilder {
  readonly #registry: FakeImageRegistry;
  readonly built: { image: string; labels: Readonly<Record<string, string>> }[] = [];
  readonly pushed: string[] = [];
  readonly removed: string[] = [];
  /** Errors to throw, one per build, before builds start succeeding. */
  readonly failures: Error[] = [];
  details: ImageDetails = { user: 'node', healthcheck: true, sizeBytes: 123_400_000, exposedPorts: ['8080/tcp'] };
  /** Called when a build starts, so a test can look at progress mid-build. */
  onBuild: (() => Promise<void>) | null = null;

  constructor(registry: FakeImageRegistry) {
    this.#registry = registry;
  }

  async build(request: { directory: string; image: string; labels: Readonly<Record<string, string>> }): Promise<void> {
    await this.onBuild?.();
    const failure = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    this.built.push({ image: request.image, labels: request.labels });
  }

  async inspect(): Promise<ImageDetails> {
    return this.details;
  }

  async push(image: string, target: string): Promise<void> {
    this.pushed.push(target);
    const digest = `sha256:${createHash('sha256').update(`${image}->${target}`).digest('hex')}`;
    const separator = target.lastIndexOf(':');
    this.#registry.tags.set(`${target.slice(0, separator)}:${target.slice(separator + 1)}`, digest);
  }

  async remove(images: readonly string[]): Promise<void> {
    this.removed.push(...images);
  }
}

/** Reports whatever vulnerabilities a test sets. */
export class FakeImageScanner implements ImageScanner {
  /** Null, as when scanning is turned off. */
  name: string | null = 'Fake scanner';
  report: ScanReport = { counts: { critical: 0, high: 0, medium: 2, low: 5, unknown: 0 }, findings: [] };

  async scan(): Promise<ScanReport> {
    return this.report;
  }
}
