import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pushInitialCommit, RemoteNotEmptyError } from '../src/tenancy/infrastructure/git-push.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('pushing the first commit', () => {
  let root: string;
  let remote: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'git-push-test-'));
    remote = join(root, 'remote.git');
    // Forgejo creates repositories whose default branch is main, as DreamDevOps asks.
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch', 'main', remote]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const clone = () => {
    const checkout = join(root, `clone-${Math.random().toString(36).slice(2)}`);
    execFileSync('git', ['clone', '--quiet', `file://${remote}`, checkout]);
    return checkout;
  };

  const files = [
    { path: 'README.md', content: '# Acme\n' },
    { path: 'src/app/main.ts', content: 'console.log("hello");\n' },
    { path: '.gitignore', content: 'node_modules\n' },
  ];

  it('pushes every file as one commit on main, by DreamDevOps', async () => {
    await pushInitialCommit({ remoteUrl: `file://${remote}`, authorization: null, files, message: 'Start here' });

    const checkout = clone();
    expect(git(checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(checkout, 'log', '--format=%an <%ae>|%s')).toBe('DreamDevOps <noreply@dreamdevops.invalid>|Start here');
    expect(git(checkout, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'README.md', 'src/app/main.ts']);
    expect(readFileSync(join(checkout, 'src/app/main.ts'), 'utf8')).toBe('console.log("hello");\n');
  });

  it('leaves a repository that already has commits as it is', async () => {
    await pushInitialCommit({ remoteUrl: `file://${remote}`, authorization: null, files, message: 'First' });

    await expect(
      pushInitialCommit({ remoteUrl: `file://${remote}`, authorization: null, files: [{ path: 'x', content: 'y' }], message: 'Second' }),
    ).rejects.toBeInstanceOf(RemoteNotEmptyError);

    expect(git(clone(), 'log', '--format=%s')).toBe('First');
  });

  it('refuses a file path that leaves the repository', async () => {
    await expect(
      pushInitialCommit({
        remoteUrl: `file://${remote}`,
        authorization: null,
        files: [{ path: '../outside.txt', content: 'no' }],
        message: 'Escape',
      }),
    ).rejects.toThrow('leaves the repository');
  });

  it('cleans up after itself, and names no address in its errors', async () => {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith('dreamdevops-push-')).length;

    const failure = pushInitialCommit({
      remoteUrl: 'http://user:secret@127.0.0.1:1/nowhere.git',
      authorization: 'Basic c2VjcmV0',
      files,
      message: 'Nowhere',
      timeoutMs: 10_000,
    });

    await expect(failure).rejects.toThrow('git push failed');
    await expect(failure).rejects.toThrow(expect.objectContaining({ message: expect.not.stringContaining('secret') }));
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith('dreamdevops-push-')).length).toBe(before);
  });
});
