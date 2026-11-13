import { spawn } from 'node:child_process';

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  /** The end of the error output, which is where tools explain what went wrong. */
  readonly stderr: string;
}

/** Keeps memory bounded while a long build writes its log. */
const MAX_STDOUT = 64 * 1024 * 1024;
const MAX_STDERR_TAIL = 16 * 1024;

export class CommandNotFoundError extends Error {
  constructor(command: string) {
    super(`The ${command} command isn't installed on the API's machine.`);
    this.name = 'CommandNotFoundError';
  }
}

/**
 * Runs a program without a shell, so no argument is ever interpreted as shell syntax.
 * It's stopped after the timeout, and its output is kept within bounds.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly env?: NodeJS.ProcessEnv; readonly cwd?: string },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < MAX_STDOUT) {
        stdout += chunk;
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_TAIL);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT' ? new CommandNotFoundError(command) : error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} ${args[0] ?? ''} took longer than ${Math.round(options.timeoutMs / 60_000)} minutes.`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/** The last few meaningful lines of a tool's output, for people to read. */
export function lastLines(output: string, count = 6): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-count)
    .join('\n')
    .slice(-1_000);
}
