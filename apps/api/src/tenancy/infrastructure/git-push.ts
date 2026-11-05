import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';
import type { RepositoryFile } from '../application/ports.ts';

export interface InitialPush {
  /** Such as https://git.example.com/acme/billing.git, or a file:// address in tests. */
  readonly remoteUrl: string;
  /** Sent as the Authorization header, or null for remotes that need none. */
  readonly authorization: string | null;
  readonly files: readonly RepositoryFile[];
  readonly message: string;
  readonly timeoutMs?: number;
}

export const BRANCH = 'main';
const AUTHOR = { name: 'DreamDevOps', email: 'noreply@dreamdevops.invalid' };
const DEFAULT_TIMEOUT_MS = 60_000;

/** The remote already had commits, so it kept them. */
export class RemoteNotEmptyError extends Error {
  constructor() {
    super('The repository already has commits.');
    this.name = 'RemoteNotEmptyError';
  }
}

/** The remote refused the credentials. */
export class GitAuthenticationError extends Error {
  constructor() {
    super('The repository refused the credentials.');
    this.name = 'GitAuthenticationError';
  }
}

/**
 * Pushes the files as one commit on main, with the git command. Credentials reach git
 * through its environment, never its arguments, so no process listing or error shows them.
 */
export async function pushInitialCommit(push: InitialPush): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dreamdevops-push-'));
  try {
    for (const file of push.files) {
      const path = normalize(join(directory, file.path));
      if (!path.startsWith(directory + sep)) {
        throw new Error(`The file path "${file.path}" leaves the repository.`);
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
    }
    const git = (...args: string[]) => run(directory, args, push);
    await git('init', '--quiet', '--initial-branch', BRANCH);
    await git('add', '--all');
    await git(
      '-c',
      `user.name=${AUTHOR.name}`,
      '-c',
      `user.email=${AUTHOR.email}`,
      'commit',
      '--quiet',
      '--no-verify',
      '--message',
      push.message,
    );
    await git('push', '--quiet', push.remoteUrl, `HEAD:refs/heads/${BRANCH}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function run(cwd: string, args: string[], push: InitialPush): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: cwd,
    // Never wait for someone to type a password.
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...(push.authorization !== null && {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: ${push.authorization}`,
    }),
  };
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), push.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`git could not run: ${error.message}. Install git where the API runs.`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else if (args[0] === 'push' && /\[rejected\]|fetch first|non-fast-forward/.test(stderr)) {
        reject(new RemoteNotEmptyError());
      } else if (args[0] === 'push' && /Authentication failed|\b40[13]\b/.test(stderr)) {
        reject(new GitAuthenticationError());
      } else {
        // The command and its output name no credentials, but the remote's address is kept out too.
        reject(new Error(`git ${args[0] === '-c' ? 'commit' : args[0]} failed with code ${code}.`));
      }
    });
  });
}
