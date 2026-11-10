import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  type BuildSource,
  PermanentBuildError,
  type PullRequest,
  type RepositoryRef,
  type Workspace,
} from '../application/ports.ts';
import { expectOk as expectForgejoOk, ForgejoApi, type ForgejoConnection, refPath } from '../../shared/forgejo/forgejo-api.ts';
import { lastLines, runCommand } from '../../shared/run-command.ts';

export interface ForgejoBuildSourceOptions extends ForgejoConnection {
  /** The largest source archive accepted. */
  readonly maxArchiveBytes?: number;
}

/** What the webhook tells the platform about. */
export const WEBHOOK_EVENTS = ['create', 'pull_request'] as const;

const PAGE_SIZE = 50;
const DEFAULT_MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
/** Files the pipeline reads, such as the Dockerfile, are small. */
const MAX_READ_BYTES = 1024 * 1024;

/** Forgejo's description of a pull request, in both its API and its webhooks. */
export interface ForgejoPullRequest {
  number?: number;
  title?: string;
  state?: string;
  merged?: boolean;
  merge_commit_sha?: string | null;
  html_url?: string;
  user?: { login?: string } | null;
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null } | null;
  base?: { ref?: string } | null;
}

export function toPullRequest(value: ForgejoPullRequest): PullRequest | null {
  if (
    typeof value.number !== 'number' ||
    typeof value.head?.ref !== 'string' ||
    typeof value.head.sha !== 'string' ||
    typeof value.base?.ref !== 'string'
  ) {
    return null;
  }
  return {
    number: value.number,
    title: typeof value.title === 'string' ? value.title.slice(0, 200) : '',
    state: value.state === 'open' ? 'open' : 'closed',
    merged: value.merged === true,
    mergeCommit: typeof value.merge_commit_sha === 'string' && value.merge_commit_sha !== '' ? value.merge_commit_sha : null,
    head: { branch: value.head.ref, commit: value.head.sha, repository: value.head.repo?.full_name ?? null },
    base: { branch: value.base.ref },
    url: typeof value.html_url === 'string' ? value.html_url : '',
    author: value.user?.login ?? null,
  };
}

/** The Forgejo adapter for builds: branches, pull requests, tags, webhooks and source archives. */
export class ForgejoBuildSource implements BuildSource {
  readonly #options: ForgejoBuildSourceOptions;
  readonly #api: ForgejoApi;

  constructor(options: ForgejoBuildSourceOptions) {
    this.#options = options;
    this.#api = new ForgejoApi(options, { defaultTimeoutMs: 30_000 });
  }

  async ensureWebhook(repository: RepositoryRef, hook: { url: string; secret: string }): Promise<void> {
    const response = await this.#api.request('GET', `${repoPath(repository)}/hooks?limit=${PAGE_SIZE}`);
    await expectOk(response, 'read the webhooks');
    const hooks = (await response.json()) as { id: number; config?: { url?: string } }[];
    const existing = hooks.find((candidate) => candidate.config?.url === hook.url);
    const body = {
      config: { url: hook.url, content_type: 'json', secret: hook.secret },
      events: WEBHOOK_EVENTS,
      active: true,
      branch_filter: '*',
    };
    const saved =
      existing === undefined
        ? await this.#api.request('POST', `${repoPath(repository)}/hooks`, { type: 'forgejo', ...body })
        : await this.#api.request('PATCH', `${repoPath(repository)}/hooks/${existing.id}`, body);
    await expectOk(saved, 'set up the webhook');
  }

  async branch(repository: RepositoryRef, name: string): Promise<{ name: string; commit: string } | null> {
    const response = await this.#api.request('GET', `${repoPath(repository)}/branches/${refPath(name)}`);
    if (response.status === 404) {
      return null;
    }
    await expectOk(response, 'read a branch');
    const branch = (await response.json()) as { name: string; commit: { id: string } };
    return { name: branch.name, commit: branch.commit.id };
  }

  async createBranch(repository: RepositoryRef, name: string, from: string): Promise<{ name: string; commit: string }> {
    const response = await this.#api.request('POST', `${repoPath(repository)}/branches`, {
      new_branch_name: name,
      old_branch_name: from,
      old_ref_name: from,
    });
    if (response.status !== 409) {
      await expectOk(response, `create ${name}`);
    }
    const branch = await this.branch(repository, name);
    if (branch === null) {
      throw new Error(`The Git service didn't create ${name}.`);
    }
    return branch;
  }

  async pullRequest(repository: RepositoryRef, number: number): Promise<PullRequest | null> {
    const response = await this.#api.request('GET', `${repoPath(repository)}/pulls/${number}`);
    if (response.status === 404) {
      return null;
    }
    await expectOk(response, 'read a pull request');
    return toPullRequest((await response.json()) as ForgejoPullRequest);
  }

  async pullRequests(repository: RepositoryRef, state: 'open' | 'closed'): Promise<PullRequest[]> {
    const response = await this.#api.request(
      'GET',
      `${repoPath(repository)}/pulls?state=${state}&sort=recentupdate&limit=${PAGE_SIZE}`,
    );
    await expectOk(response, 'list pull requests');
    return ((await response.json()) as ForgejoPullRequest[]).flatMap((value) => toPullRequest(value) ?? []);
  }

  async checkout(repository: RepositoryRef, commit: string): Promise<Workspace> {
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
      throw new PermanentBuildError('The commit to build is not valid.');
    }
    const directory = await mkdtemp(join(tmpdir(), 'dreamdevops-source-'));
    const source = join(directory, 'source');
    try {
      const response = await this.#api.request('GET', `${repoPath(repository)}/archive/${commit}.tar.gz`, undefined, {
        accept: 'application/octet-stream',
        timeoutMs: 10 * 60_000,
      });
      if (response.status === 404) {
        throw new PermanentBuildError(`The commit ${commit.slice(0, 12)} isn't in the repository.`);
      }
      await expectOk(response, 'download the source');
      const archive = join(directory, 'source.tar.gz');
      await pipeline(
        Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
        limitSize(this.#options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES),
        createWriteStream(archive, { mode: 0o600 }),
      );
      await mkdir(source);
      // Forgejo's archives hold one top folder named after the repository, which is left out.
      const extracted = await runCommand('tar', ['-xzf', archive, '-C', source, '--strip-components=1'], {
        timeoutMs: 5 * 60_000,
      });
      if (extracted.code !== 0) {
        throw new Error(`The source couldn't be unpacked: ${lastLines(extracted.stderr)}`);
      }
      await rm(archive, { force: true });
      return new DirectoryWorkspace(source, directory);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async createTag(repository: RepositoryRef, tag: { name: string; commit: string; message: string }): Promise<void> {
    const check = async (): Promise<boolean> => {
      const response = await this.#api.request('GET', `${repoPath(repository)}/tags/${refPath(tag.name)}`);
      if (response.status === 404) {
        return false;
      }
      await expectOk(response, 'read a tag');
      const existing = (await response.json()) as { commit?: { sha?: string } };
      if (existing.commit?.sha !== tag.commit) {
        throw new PermanentBuildError(`The tag ${tag.name} already exists on another commit.`);
      }
      return true;
    };
    if (await check()) {
      return;
    }
    const response = await this.#api.request('POST', `${repoPath(repository)}/tags`, {
      tag_name: tag.name,
      target: tag.commit,
      message: tag.message,
    });
    if (response.status === 409 || response.status === 422) {
      if (await check()) {
        return;
      }
    }
    await expectOk(response, `create the tag ${tag.name}`);
  }
}

/** A folder holding the source. Reads stay inside it, and never follow links. */
export class DirectoryWorkspace implements Workspace {
  readonly directory: string;
  readonly #root: string;

  constructor(directory: string, root: string = directory) {
    this.directory = directory;
    this.#root = root;
  }

  async readFile(file: string): Promise<string | null> {
    const target = insideFolder(this.directory, file);
    if (target === null) {
      return null;
    }
    try {
      const stats = await lstat(target);
      if (!stats.isFile() || stats.size > MAX_READ_BYTES) {
        return null;
      }
      return await readFile(target, 'utf8');
    } catch {
      return null;
    }
  }

  async dispose(): Promise<void> {
    await rm(this.#root, { recursive: true, force: true });
  }
}

/**
 * The full path of a file inside a folder, or null if the path leads anywhere else. On
 * Windows, a path on another drive or a network share has no relative path from the
 * folder, so relative() returns it whole, which is why absolute results are refused too.
 */
export function insideFolder(
  directory: string,
  file: string,
  paths: Pick<typeof path, 'isAbsolute' | 'relative' | 'resolve' | 'sep'> = path,
): string | null {
  const target = paths.resolve(directory, file);
  const inside = paths.relative(directory, target);
  if (inside === '' || inside === '..' || inside.startsWith(`..${paths.sep}`) || paths.isAbsolute(inside)) {
    return null;
  }
  return target;
}

function limitSize(maxBytes: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new PermanentBuildError(`The source is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`));
        return;
      }
      callback(null, chunk);
    },
  });
}

function repoPath(repository: RepositoryRef): string {
  return `/repos/${encodeURIComponent(repository.organization)}/${encodeURIComponent(repository.name)}`;
}

function expectOk(response: Response, action: string): Promise<void> {
  return expectForgejoOk(response, action, PermanentBuildError);
}
